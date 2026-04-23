// ================= IMPORTS =================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// ================= APP =================
const app = express();
app.use(cors());
app.use(express.json({ limit: "50kb" }));

const PORT = process.env.PORT || 3000;

// ================= KEYS =================
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ================= AI CLIENTS =================
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

const groq = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ================= MEMORY STORE (TEMP) =================
const chatUsage = {};

// ================= UTILS =================
const isValidNumber = (n) =>
  typeof n === "number" && Number.isFinite(n);

const safeTrim = (text, max = 300) => {
  if (!text || text.length <= max) return text || "";

  let trimmed = text.slice(0, max);
  const lastDot = trimmed.lastIndexOf(".");
  const lastNewLine = trimmed.lastIndexOf("\n");
  const lastBullet = trimmed.lastIndexOf("•");

  const cutIndex = Math.max(lastDot, lastNewLine, lastBullet);

  if (cutIndex > 0) {
    return trimmed.slice(0, cutIndex).trim();
  }

  return trimmed;
};

const getTopCategory = (map) => {
  try {
    const entries = Object.entries(map || {});
    if (!entries.length) return "general";
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  } catch {
    return "general";
  }
};

const withTimeout = (promise, ms = 5000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms)
    ),
  ]);

// ================= AI CALLS =================
const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-pro-latest",
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
      console.warn(`Gemini ${modelName} failed:`, err.message);
    }
  }
  throw new Error("Gemini failed");
}

async function callGroq(prompt) {
  const completion = await withTimeout(
    groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are a smart financial advisor." },
        { role: "user", content: prompt },
      ],
      max_tokens: 150,
      temperature: 0.6,
    }),
    5000
  );

  return completion?.choices?.[0]?.message?.content || "";
}

// ================= HEALTH =================
app.get("/", (_, res) => {
  res.send("AI Backend Running 🚀");
});

// =====================================================
// ✅ 1. INSIGHT ENDPOINT (NO LIMIT)
// =====================================================
app.post("/ai", async (req, res) => {
  const start = Date.now();

  try {
    const { userId, income, totalExpense, categoryBreakdown } = req.body;

    // -------- VALIDATION --------
    if (!userId) return res.status(400).json({ error: "Invalid userId" });

    if (!isValidNumber(income) || !isValidNumber(totalExpense)) {
      return res.status(400).json({ error: "Invalid numbers" });
    }

    if (!categoryBreakdown || typeof categoryBreakdown !== "object") {
      return res.status(400).json({ error: "Invalid category data" });
    }

    // -------- BUSINESS LOGIC --------
    const overspending = totalExpense - income;

    const status =
      overspending > 0
        ? `Overspending by ₹${Math.round(overspending)}`
        : `Budget is in control`;

    const topCategory = getTopCategory(categoryBreakdown);

    // -------- PROMPT --------
    const prompt = `
You are a financial advisor.

User:
Status: ${status}
Top Category: ${topCategory}

Rules:
- Max 60 words
- 3 bullet tips
- Practical advice
- Friendly tone

Format:
Status: ...
Tips:
• ...
• ...
• ...
`;

    // -------- AI EXECUTION --------
    let reply = "";
    let source = "gemini";

    try {
      reply = await callGemini(prompt);
    } catch {
      reply = await callGroq(prompt);
      source = "groq";
    }
    console.log("Insight AI Source:", source);

    if (!reply) {
      reply = "Unable to generate insight. Try again.";
    }

    return res.json({
      reply: safeTrim(reply, 300),
      source,
      latencyMs: Date.now() - start,
    });

  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// =====================================================
// ✅ 2. CHAT ENDPOINT (LIMIT = 15)
// =====================================================
app.post("/aichat", async (req, res) => {
  try {
  
    const { userId, message, income, totalExpense, categoryBreakdown } = req.body;

    if (!userId) return res.status(400).json({ error: "Invalid userId" });
    if (!message) return res.status(400).json({ error: "Message required" });

    chatUsage[userId] = chatUsage[userId] || 0;

    if (chatUsage[userId] >= 15) {
      return res.status(403).json({
        error: "Free limit reached. Upgrade to premium.",
      });
    }

    chatUsage[userId]++;

    const topCategory = getTopCategory(categoryBreakdown);

    const status =
      totalExpense > income
        ? `Overspending`
        : `Within budget`;

    const prompt = `
You are a smart personal finance assistant.

User Financial Context:
- Status: ${status}
- Top Spending Category: ${topCategory}

User Question:
${message}

Rules:
- DO NOT mention exact numbers
- Give practical tips
- Max 80 words
`;

    let reply = "";
    let source = "gemini";

    try {
      reply = await callGemini(prompt);
    } catch {
      reply = await callGroq(prompt);
      source = "groq";
    }

    return res.json({
      reply: safeTrim(reply, 400),
      source,
      remaining: 15 - chatUsage[userId],
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});