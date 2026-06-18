require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Read API key from .env file
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kiosk.html"));
});

// ── Session Cache (3 minutes) ──────────────────────────────
const sessionCache = new Map();
const SESSION_TTL = 3 * 60 * 1000; // 3 minutes

function getSession(sessionId) {
  const entry = sessionCache.get(sessionId);

  if (!entry) return null;

  if (Date.now() - entry.timestamp > SESSION_TTL) {
    sessionCache.delete(sessionId);
    return null;
  }

  return entry;
}

function setSession(sessionId, data) {
  sessionCache.set(sessionId, {
    data,
    timestamp: Date.now()
  });

  // Remove expired sessions
  for (const [key, value] of sessionCache.entries()) {
    if (Date.now() - value.timestamp > SESSION_TTL) {
      sessionCache.delete(key);
    }
  }
}
// ────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/analyze", async (req, res) => {
  try {
    const {
  imageBase64,
  gender,
  category,
  clothType,
  occasion,
  language,
  sessionId,
  forceRetake
} = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "No image provided." });
    }

    // ── Check session cache first ─────────────────────────────────
if (sessionId && !forceRetake) {
  const existing = getSession(sessionId);

  if (existing) {
    console.log("✅ Returning previous session report");

    return res.json({
      success: true,
      data: existing.data,
      fromCache: true,
      previousAnalysisTime: existing.timestamp
    });
  }
}

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

    // ══════════════════════════════════════════════════════════════
    // STEP 1 — IMAGE VALIDATION
    // Ask Gemini to check: real person? face/body visible? good quality?
    // ══════════════════════════════════════════════════════════════
    console.log("🔍 Step 1: Validating image...");

    const validationPrompt = `Look at this image carefully.
Return ONLY this exact JSON — no markdown, no extra text:
{
  "validPerson": true,
  "faceVisible": true,
  "upperBodyVisible": true,
  "fullBodyVisible": false,
  "imageQuality": "Good",
  "confidence": 95,
  "reason": "Face and upper body are clearly visible"
}

Rules:
- validPerson: true ONLY if a real human person is clearly present and visible. If the image is a covered camera, wall, ceiling, floor, hand, random object, dark/black screen, or anything other than a person → false.
- faceVisible: true only if a human face is clearly visible (not blurred, not covered).
- upperBodyVisible: true only if shoulders and chest area are clearly visible.
- fullBodyVisible: true only if the full body from head to feet is visible.
- imageQuality: "Good" | "Poor" | "Blurry" | "TooClose" | "TooDark"
- confidence: integer 0–100 of how confident you are a valid person is present.
- reason: short description of what you see.

IMPORTANT: If this image is a covered lens, black frame, ceiling, wall, floor, hand covering camera, or any non-person image → set validPerson to false.`;

    const validationResult = await model.generateContent([
      { text: validationPrompt },
      { inlineData: { data: imageBase64, mimeType: "image/jpeg" } }
    ]);

    const validationRaw = validationResult.response.text();
    const validationClean = validationRaw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

    let validation;
    try {
      validation = JSON.parse(validationClean);
    } catch {
      const match = validationClean.match(/\{[\s\S]*\}/);
      if (match) validation = JSON.parse(match[0]);
      else validation = { validPerson: false, reason: "Could not read image" };
    }

    console.log("📋 Validation result:", validation);

    // ── REJECT: No person detected ──────────────────────────────
    if (!validation.validPerson) {
      return res.status(400).json({
        success: false,
        validationFailed: true,
        validationCode: "NO_PERSON",
        error: "No person detected. Please stand in front of the camera and try again.",
        detail: validation.reason || "The image does not contain a visible person."
      });
    }

    // ── REJECT: Poor image quality ──────────────────────────────
    if (validation.imageQuality === "Poor" || validation.imageQuality === "TooDark" || validation.imageQuality === "Blurry") {
      return res.status(400).json({
        success: false,
        validationFailed: true,
        validationCode: "POOR_QUALITY",
        error: `Image quality is ${validation.imageQuality}. Please ensure good lighting and a clear camera view.`,
        detail: validation.reason || "Image quality is insufficient for analysis."
      });
    }

    // ── REJECT: Low confidence ──────────────────────────────────
    if ((validation.confidence || 100) < 70) {
      return res.status(400).json({
        success: false,
        validationFailed: true,
        validationCode: "LOW_CONFIDENCE",
        error: "Image is unclear. Please face the camera directly and try again.",
        detail: validation.reason || "Confidence too low to proceed."
      });
    }

    // ── REJECT: Category-specific body visibility check ─────────
    if (category === "Topwear" && !validation.upperBodyVisible && !validation.faceVisible) {
      return res.status(400).json({
        success: false,
        validationFailed: true,
        validationCode: "BODY_NOT_VISIBLE",
        error: "Please face the camera and ensure your upper body is clearly visible.",
        detail: "Face and upper body must be visible for topwear analysis."
      });
    }

    if ((category === "Bottomwear" || category === "Full Outfit") && !validation.fullBodyVisible) {
      return res.status(400).json({
        success: false,
        validationFailed: true,
        validationCode: "FULL_BODY_REQUIRED",
        error: "Please step back so your full body is visible in the frame.",
        detail: "Full body must be visible for bottomwear / full outfit analysis."
      });
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 2 — FULL FASHION ANALYSIS (only if validation passed)
    // ══════════════════════════════════════════════════════════════
    console.log("✨ Step 2: Running fashion analysis...");

   const prompt = `
You are a premium AI Fashion Stylist for an Indian clothing store.

Analyze ONLY what is clearly visible in the image.
Never guess or invent information.
If something cannot be determined, return "Unknown".

Customer:
- Gender: ${gender}
- Category: ${category}
- Clothing Type: ${clothType}
- Occasion: ${occasion}
- Selected Language: ${language}

========================
CRITICAL LANGUAGE RULE
========================

ALL text visible to the customer MUST be in "${language}".

DO NOT use English unless "${language}" is English.

Translate EVERYTHING including:
- greeting
- skinTone
- bodyShape
- confidenceLevel
- styleScoreReason
- suitableColors names and reasons
- avoidColors names and reasons
- whyItWorks
- bestFit
- fabrics
- necklineRecommendation
- sleeveRecommendation
- patternRecommendation
- suitableOccasions
- outfitSuggestions
- accessories
- bestSeasons
- styleTip

========================
ANALYSIS RULES
========================

- Base recommendations ONLY on visible appearance.
- Do not make assumptions.
- Different people should receive different recommendations.
- Use realistic Indian fashion advice.
- Match recommendations to the selected occasion.
- Do NOT always recommend Navy Blue, Black, White or Olive.
- Do NOT always recommend Cotton.
- Style score should realistically vary between 70 and 99.
- Keep explanations short and natural.

Return ONLY valid JSON with NO markdown and NO extra text.

{
  "greeting": "",
  "skinTone": "",
  "bodyShape": "",
  "confidenceLevel": "",
  "styleScore": 0,
  "styleScoreReason": "",

  "suitableColors": [
    {
      "name": "",
      "hex": "",
      "reason": ""
    },
    {
      "name": "",
      "hex": "",
      "reason": ""
    },
    {
      "name": "",
      "hex": "",
      "reason": ""
    }
  ],

  "avoidColors": [
    {
      "name": "",
      "hex": "",
      "reason": ""
    },
    {
      "name": "",
      "hex": "",
      "reason": ""
    }
  ],

  "whyItWorks": "",
  "bestFit": "",

  "fabrics": [],

  "necklineRecommendation": [],

  "sleeveRecommendation": [],

  "patternRecommendation": [],

  "suitableOccasions": [],

  "outfitSuggestions": [
    {
      "items": [
        {
          "icon": "👕",
          "piece": ""
        },
        {
          "icon": "👖",
          "piece": ""
        },
        {
          "icon": "👟",
          "piece": ""
        }
      ]
    },
    {
      "items": [
        {
          "icon": "🧥",
          "piece": ""
        },
        {
          "icon": "⌚",
          "piece": ""
        },
        {
          "icon": "👜",
          "piece": ""
        }
      ]
    }
  ],

  "accessories": {
    "Shoes": "",
    "Watch": "",
    "Bag": "",
    "Belt": "",
    "Eyewear": ""
  },

  "bestSeasons": [],

  "styleTip": ""
}

Output ONLY the JSON object.
`;

    



const result = await model.generateContent([
      { text: prompt },
      { inlineData: { data: imageBase64, mimeType: "image/jpeg" } }
    ], {
      generationConfig: {
  temperature: 0.3,
  maxOutputTokens: 2500
} // Low temperature = consistent results
    });

    const raw = result.response.text();
    console.log(raw);
    const clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("AI returned invalid JSON: " + clean.substring(0, 200));
    }

    // Save to session cache
if (sessionId) {
  setSession(sessionId, parsed);
}
    console.log("✅ Analysis complete — report generated");

    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Fashion Kiosk AI — Server Running ✓    ║");
  console.log(`║   Open: http://localhost:${PORT}            ║`);
  console.log("╚══════════════════════════════════════════╝");
});
