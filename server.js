import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50kb" }));

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ---------------- AI SETUP ----------------
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

const groq = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ---------------- TEMP STORE ----------------
const userUsage = {};

// ---------------- UTIL ----------------
const isValidNumber = (n) =>
  typeof n === "number" && Number.isFinite(n);

const safeTrim = (text, maxChars = 280) =>
  text?.length > maxChars ? text.slice(0, maxChars) : text || "";

const getTopCategory = (map) => {
  try {
    const entries = Object.entries(map || {});
    if (!entries.length) return "general";
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  } catch {
    return "general";
  }
};

// Timeout wrapper (important in production)
const withTimeout = (promise, ms = 5000) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms)
    ),
  ]);
};

// ---------------- GEMINI SAFE CALL ----------------
const GEMINI_MODELS = [
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest"
];

async function callGemini(prompt) {
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });

      const result = await withTimeout(
        model.generateContent(prompt),
        5000
      );

      const text = result?.response?.text?.();
      if (text) return text;

    } catch (err) {
      console.warn(`Gemini model ${modelName} failed:`, err.message);
    }
  }
  throw new Error("All Gemini models failed");
}

// ---------------- GROQ SAFE CALL ----------------
async function callGroq(prompt) {
  const completion = await withTimeout(
    groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are a strict financial advisor." },
        { role: "user", content: prompt },
      ],
      max_tokens: 120,
      temperature: 0.5,
    }),
    5000
  );

  return completion?.choices?.[0]?.message?.content || "";
}

// ---------------- HEALTH ----------------
app.get("/", (_, res) => {
  res.send("AI Backend Running 🚀");
});

// ---------------- AI ENDPOINT ----------------
app.post("/ai", async (req, res) => {
  const startTime = Date.now();

  try {
    const { userId, income, totalExpense, categoryBreakdown } = req.body;

    // ---------------- VALIDATION ----------------
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid userId" });
    }

    if (!isValidNumber(income) || !isValidNumber(totalExpense)) {
      return res.status(400).json({ error: "Invalid financial values" });
    }

    if (
      !categoryBreakdown ||
      typeof categoryBreakdown !== "object" ||
      Array.isArray(categoryBreakdown)
    ) {
      return res.status(400).json({ error: "Invalid category data" });
    }

    // ---------------- RATE LIMIT ----------------
    userUsage[userId] = userUsage[userId] || 0;

    if (userUsage[userId] >= 5) {
      return res.status(403).json({
        error: "Free limit reached. Upgrade to premium.",
      });
    }

    userUsage[userId]++;

    // ---------------- BUSINESS LOGIC ----------------
    const overspending = totalExpense - income;

    const status =
      overspending > 0
        ? `Overspending by ₹${Math.round(overspending)}`
        : `Budget is in control`;

    const topCategory = getTopCategory(categoryBreakdown);

    // ---------------- PROMPT ----------------
    const prompt = `
You are a concise financial advisor.

User:
Status: ${status}
Top Category: ${topCategory}

Rules:
- Max 60 words
- No income/total mention
- 3 practical tips
- Use • bullets

Format:
Status: ...
Tips:
• ...
• ...
• ...
`;

    // ---------------- AI EXECUTION ----------------
    let reply = "";
    let source = "gemini";

    try {
      reply = await callGemini(prompt);
    } catch (geminiErr) {
      console.warn("Gemini failed → fallback to Groq");

      try {
        reply = await callGroq(prompt);
        source = "groq";
      } catch (groqErr) {
        console.error("Groq failed:", groqErr.message);
        return res.status(503).json({
          error: "AI services unavailable",
        });
      }
    }

    // ---------------- RESPONSE ----------------
    const response = {
      reply: safeTrim(reply),
      source,
      latencyMs: Date.now() - startTime,
    };

    return res.json(response);

  } catch (err) {
    console.error("Unhandled error:", err.message);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});