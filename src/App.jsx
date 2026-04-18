import React, { useState, useRef, useCallback, useEffect } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, addDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

// ─── FIREBASE INITIALIZATION (MANDATORY PATTERN) ─────────────────────────────
const firebaseConfig = typeof __firebase_config !== "undefined" ? JSON.parse(__firebase_config) : {};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== "undefined" ? __app_id : "dainik-bhaskar-app";

// ─── GEMINI API SETUP ────────────────────────────────────────────────────────
const apiKey = ""; // Environment securely injects this
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

async function callGemini(systemPrompt, userText, inlineData = null, isJson = true) {
  const payload = {
    contents: [
      {
        role: "user",
        parts: []
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    }
  };

  if (userText) {
    payload.contents[0].parts.push({ text: userText });
  }

  if (inlineData) {
    payload.contents[0].parts.push({ inlineData });
  }

  if (isJson) {
    payload.generationConfig = { responseMimeType: "application/json" };
  }

  // Exponential Backoff Retry Logic
  const delays = [1000, 2000, 4000, 8000, 16000];
  let lastError = null;

  for (let i = 0; i < delays.length + 1; i++) {
    try {
      const response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP Error ${response.status}`);
      }

      const data = await response.json();
      const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      if (isJson) {
        return extractJSON(textResponse);
      }
      return textResponse;
    } catch (err) {
      lastError = err;
      if (i < delays.length) {
        await new Promise(res => setTimeout(res, delays[i]));
      }
    }
  }
  throw lastError;
}

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function extractJSON(raw) {
  let s = raw.replace(/```json|```/gi, "").trim();
  try { return JSON.parse(s); } catch (_) {}
  const st = s.indexOf("{"), en = s.lastIndexOf("}");
  if (st !== -1 && en !== -1) { try { return JSON.parse(s.slice(st, en + 1)); } catch (_) {} }
  return null;
}

const countWords = t => t?.trim() ? t.trim().split(/\s+/).length : 0;
const truncateWords = (t, n) => { const w = t?.trim().split(/\s+/); return w?.length <= n ? t : w?.slice(0, n).join(" ") + "…"; };

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("File read failed"));
    r.readAsDataURL(file);
  });
}

// ─── PROMPTS & STYLES ────────────────────────────────────────────────────────

const DB_STYLE = `
DAINIK BHASKAR EDITORIAL STYLE (MANDATORY):
1. LEAD: Answer कौन/क्या/कहाँ/कब/क्यों in first 2-3 lines. Most important fact FIRST.
2. LANGUAGE: Simple Khari Boli Hindi. Short sentences ≤20 words. Active voice.
3. TONE: Authoritative, accessible, never sensational. Facts-first.
4. STRUCTURE: Lead → Key facts → Background → Quote → Impact/What next.
5. NUMBERS: Always digits (5 not पाँच). ₹ symbol. % for percentages.
6. ATTRIBUTION: Every claim needs source — "पुलिस के अनुसार", "अधिकारियों ने बताया".
7. FACT CHECKING: You must rigorously ensure numbers, names, and facts match between the headline and the body.
`;

const ANALYSIS_PROMPT = `You are an expert Hindi language editor and fact-checker for Dainik Bhaskar.
FONT-ENCODING RULES (STRICT — never flag these): अा vs आ, ाे/ाै vs ो/ौ. Only flag genuine grammar mistakes.

CRITICAL FACT CHECKING: Compare the headline/title (if any) with the story body. Look for ANY mismatched numbers (e.g., 100 in body, 10000 in headline), mismatched names, or contradictory facts.

Respond ONLY with a valid JSON object matching this structure:
{
  "errors": [ { "original": "exact substring", "correction": "corrected", "explanation": "short reason" } ],
  "fact_checks": [ { "issue": "describe the mismatch between headline/body or logical error", "severity": "High|Medium", "correction_suggestion": "what it should be" } ],
  "pairs": [ { "headline": "Hindi headline", "subheadline": "matching sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "angle": "one word", "score": 90 } ],
  "summary": "2-3 sentence editorial feedback in Hindi",
  "seo_keywords": ["keyword1","keyword2","keyword3"],
  "story_category": "politics|crime|sports|health|business|local|national|international|entertainment",
  "missing_elements": ["element if any important journalistic element is missing"]
}
Rules: EXACTLY 5 high-quality pairs. Score 1-100. Escape quotes properly.`;

const HEADLINES_PROMPT = `You are a senior Dainik Bhaskar headline writer.
Generate exactly 10 headline+subheadline pairs based on the text. 
Ensure NO FACTUAL MISMATCHES (numbers/names must be 100% accurate based on the text).
Respond ONLY with JSON:
{ "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "breaking|informative|dramatic", "angle": "one word", "score": 90 } ] }`;

const REWRITE_PROMPT = `You are a senior state editor at Dainik Bhaskar.
${DB_STYLE}
Ensure 100% factual accuracy. Do not invent numbers or names.
Respond ONLY with JSON: { "rewritten": "full DB-style Hindi article" }`;

const MEDIA_TO_NEWS_PROMPT = `You are a senior reporter at Dainik Bhaskar newspaper.
${DB_STYLE}
Extract all facts from the provided document/image/text. Translate to Hindi if necessary. Write a proper news article.
Respond ONLY with JSON:
{
  "article": "complete Hindi news article in DB style",
  "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "informative", "score": 90 } ],
  "summary": "brief note about the source content in English",
  "detected_language": "Hindi|English|Mixed|Other"
}`;

const STYLE_COLORS = { breaking: "#EF4444", informative: "#3B82F6", dramatic: "#8B5CF6", soft: "#10B981", question: "#F59E0B", statistic: "#06B6D4" };
const CAT_COLORS = { politics:"#EF4444", crime:"#F97316", sports:"#10B981", health:"#06B6D4", business:"#3B82F6", local:"#8B5CF6", national:"#F59E0B", international:"#EC4899", entertainment:"#14B8A6" };

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function App() {
  // Auth State
  const [user, setUser] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // App State - Tabs
  const [mainTab, setMainTab] = useState("editor"); // 'editor' | 'inbox'

  // Editor State
  const [article, setArticle]     = useState("");
  const [analysis, setAnalysis]   = useState(null);
  const [segments, setSegments]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [apiError, setApiError]   = useState(null);
  const [activeTab, setActiveTab] = useState("grammar");

  const [storyLimit, setStoryLimit] = useState("");

  // Headlines
  const [hlPrompt, setHlPrompt]       = useState("");
  const [hlHeadLimit, setHlHeadLimit] = useState("");
  const [hlSubLimit, setHlSubLimit]   = useState("");
  const [hlLoading, setHlLoading]     = useState(false);
  const [customPairs, setCustomPairs] = useState(null);

  // Rewrite panel
  const [rwOpen, setRwOpen]     = useState(false);
  const [rwPrompt, setRwPrompt] = useState("");
  const [rwLimit, setRwLimit]   = useState("");
  const [rwLoading, setRwLoading] = useState(false);
  const [rwResult, setRwResult] = useState(null);
  const [rwDispLimit, setRwDispLimit] = useState("");

  // Media upload
  const [mediaLoading, setMediaLoading] = useState(false);
  const fileRef   = useRef(null);

  // Version history
  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);

  // Inbox State
  const [inboxMessages, setInboxMessages] = useState([]);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [inboxLoading, setInboxLoading] = useState(false);

  // ─── 1. FIREBASE AUTHENTICATION EFFECT ───────────────────────────────────
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth Error:", err);
      } finally {
        setIsInitializing(false);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // ─── 2. FIREBASE FIRESTORE EFFECT (INBOX) ────────────────────────────────
  useEffect(() => {
    if (!user) return;
    
    // Subscribe to WhatsApp Inbox collection
    const inboxRef = collection(db, 'artifacts', appId, 'users', user.uid, 'whatsapp_inbox');
    
    // Simple query, no ordering/limiting required by rules, sort in memory
    const unsubscribe = onSnapshot(inboxRef, (snapshot) => {
      const messages = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      // Sort by timestamp in memory descending
      messages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setInboxMessages(messages);
    }, (error) => {
      console.error("Firestore error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  // ─── ACTIONS ─────────────────────────────────────────────────────────────

  const saveVersion = useCallback((text, label) => {
    setVersions(v => [...v.slice(-9), { text, label, time: new Date().toLocaleTimeString("en-IN") }]);
  }, []);

  const clearAll = () => {
    setArticle(""); setAnalysis(null); setSegments([]);
    setCustomPairs(null); setRwResult(null); 
    setApiError(null); setStoryLimit(""); setHlPrompt(""); setHlHeadLimit(""); setHlSubLimit("");
    setRwPrompt(""); setRwLimit(""); setRwDispLimit(""); 
    setRwOpen(false); setShowVersions(false);
  };

  const buildSegments = (text, errors) => {
    if (!errors || errors.length === 0) return [{ type: "normal", text }];
    const positioned = [], used = [];
    for (const err of errors) {
      const idx = text.indexOf(err.original);
      if (idx === -1) continue;
      if (used.some(([s, e]) => idx < e && idx + err.original.length > s)) continue;
      used.push([idx, idx + err.original.length]);
      positioned.push({ ...err, start: idx, end: idx + err.original.length });
    }
    positioned.sort((a, b) => a.start - b.start);
    const segs = []; let cur = 0;
    for (const p of positioned) {
      if (p.start > cur) segs.push({ type: "normal", text: text.slice(cur, p.start) });
      segs.push({ type: "error", ...p });
      cur = p.end;
    }
    if (cur < text.length) segs.push({ type: "normal", text: text.slice(cur) });
    return segs;
  };

  // ── Analyse ──
  const analyse = useCallback(async () => {
    if (article.trim().length < 20) { setApiError("Please write at least 20 characters."); return; }
    setLoading(true); setLoadingMsg("Checking grammar & facts…"); setApiError(null);
    setAnalysis(null); setSegments([]); setCustomPairs(null); setRwResult(null);
    try {
      const parsed = await callGemini(ANALYSIS_PROMPT, `Analyse this Dainik Bhaskar news article:\n\n${article}`);
      setAnalysis(parsed);
      setSegments(buildSegments(article, parsed.errors || []));
      
      if (parsed.fact_checks && parsed.fact_checks.length > 0) {
        setActiveTab("facts");
      } else {
        setActiveTab("grammar");
      }
    } catch (e) { setApiError(`Analysis Error: ${e.message}`); }
    finally { setLoading(false); setLoadingMsg(""); }
  }, [article]);

  // ── Rewrite ──
  const rewrite = useCallback(async () => {
    if (!article.trim()) { setApiError("Write an article first."); return; }
    saveVersion(article, "Before rewrite");
    setRwLoading(true); setApiError(null); setRwResult(null);
    try {
      let instr = rwPrompt.trim() || "Rewrite in professional Dainik Bhaskar style.";
      if (rwLimit) instr += ` STRICT word limit: max ${rwLimit} words.`;
      
      const parsed = await callGemini(REWRITE_PROMPT, `Original Article:\n${article}\n\nInstruction: ${instr}`);
      setRwResult(parsed.rewritten || "");
      setRwDispLimit(rwLimit);
    } catch (e) { setApiError(`Rewrite Error: ${e.message}`); }
    finally { setRwLoading(false); }
  }, [article, rwPrompt, rwLimit, saveVersion]);

  // ── Custom Headlines ──
  const genHeadlines = useCallback(async () => {
    if (!article.trim()) { setApiError("Write an article first."); return; }
    setHlLoading(true); setApiError(null);
    try {
      let instr = hlPrompt.trim() || "Generate 10 best pairs.";
      if (hlHeadLimit) instr += ` Each headline max ${hlHeadLimit} words.`;
      if (hlSubLimit)  instr += ` Each sub-headline max ${hlSubLimit} words.`;
      
      const parsed = await callGemini(HEADLINES_PROMPT, `Article:\n${article}\n\nInstruction: ${instr}`);
      setCustomPairs(parsed.pairs || []);
    } catch (e) { setApiError(`Headlines Error: ${e.message}`); }
    finally { setHlLoading(false); }
  }, [article, hlPrompt, hlHeadLimit, hlSubLimit]);

  // ── Media to News (Upload) ──
  const processMedia = useCallback(async (file) => {
    setMediaLoading(true); setApiError(null);
    
    try {
      const isImage = file.type.startsWith("image/");
      const isPDF   = file.type === "application/pdf";
      let inlineData = null;
      let promptText = "Extract news from this content and write a Dainik Bhaskar Hindi news article.";

      if (isImage || isPDF) {
        const b64 = await toBase64(file);
        inlineData = { mimeType: file.type, data: b64 };
        promptText = "Read all text/content from this file and write a complete Dainik Bhaskar style Hindi news article.";
      } else {
        const text = await file.text().catch(() => `[File: ${file.name}]`);
        promptText = `Extract news from this file content and write a Dainik Bhaskar Hindi news article:\n\nFilename: ${file.name}\n\nContent:\n${text}`;
      }

      const parsed = await callGemini(MEDIA_TO_NEWS_PROMPT, promptText, inlineData);
      
      if (parsed && parsed.article) {
        saveVersion(article, "Before Media Upload");
        setArticle(parsed.article);
        // Automatically run analysis after a brief delay for UX
        setTimeout(() => analyse(), 500);
      } else {
        throw new Error("Could not extract news from the file.");
      }
    } catch (e) { setApiError(`Media Error: ${e.message}`); }
    finally { setMediaLoading(false); }
  }, [article, saveVersion, analyse]);

  const handleFileInput = e => {
    const file = e.target.files[0];
    if (file) processMedia(file);
  };

  // ── Translate to Hindi ──
  const translateToHindi = useCallback(async () => {
    if (!article.trim()) { setApiError("Write text to translate."); return; }
    setLoading(true); setLoadingMsg("Translating & Formatting..."); setApiError(null);
    try {
      const parsed = await callGemini(REWRITE_PROMPT, `Translate this strictly to Hindi and rewrite in Dainik Bhaskar format:\n\n${article}`);
      saveVersion(article, "Before translation");
      setArticle(parsed.rewritten || "");
    } catch (e) { setApiError(`Translation Error: ${e.message}`); }
    finally { setLoading(false); setLoadingMsg(""); }
  }, [article, saveVersion]);


  // ─── INBOX (WHATSAPP SIMULATION) ACTIONS ─────────────────────────────────

  const simulateIncomingMessage = async () => {
    if (!user) return;
    const dummyMessages = [
      "Breaking: A major accident occurred on Jaipur highway today morning involving 3 trucks. 12 people injured. Police have reached the spot. Rescue operations underway.",
      "CM announced a new scheme for farmers today. They will get 10,000 rs per month instead of 5000. Registration starts next week from local panchayats.",
      "Weather update: Heavy rain expected in Ujjain and Indore divisions for the next 48 hours. Red alert issued by meteorological department. Schools advised to remain closed."
    ];
    const randomMsg = dummyMessages[Math.floor(Math.random() * dummyMessages.length)];
    
    try {
      const inboxRef = collection(db, 'artifacts', appId, 'users', user.uid, 'whatsapp_inbox');
      await addDoc(inboxRef, {
        sender: "+91 98765 432" + Math.floor(Math.random() * 90),
        original_text: randomMsg,
        timestamp: Date.now(),
        status: "unread",
        rewritten: null
      });
    } catch (err) {
      console.error("Failed to simulate message", err);
    }
  };

  const processInboxMessage = async (msg) => {
    setSelectedMessage(msg);
    if (msg.rewritten) return; // Already processed

    setInboxLoading(true);
    try {
      const parsed = await callGemini(
        MEDIA_TO_NEWS_PROMPT, 
        `Write a Dainik Bhaskar style Hindi news article from this raw WhatsApp press note/tip:\n\n${msg.original_text}`
      );
      
      const updatedData = {
        ...msg,
        status: "processed",
        rewritten: parsed.article || "Could not generate rewrite."
      };

      // Save back to Firestore
      const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'whatsapp_inbox', msg.id);
      await setDoc(docRef, updatedData, { merge: true });
      
      setSelectedMessage(updatedData);
    } catch (err) {
      console.error("Error processing message:", err);
    } finally {
      setInboxLoading(false);
    }
  };

  const useInboxStory = () => {
    if (selectedMessage && selectedMessage.rewritten) {
      saveVersion(article, "Before importing from Inbox");
      setArticle(selectedMessage.rewritten);
      setMainTab("editor");
    }
  };


  // ─── RENDER COMPUTATIONS ──────────────────────────────────────────────────

  const words     = countWords(article);
  const overLimit = storyLimit && parseInt(storyLimit) > 0 && words > parseInt(storyLimit);
  const errCount  = segments.filter(s => s.type === "error").length;
  const factCount = analysis?.fact_checks?.length || 0;
  const displayPairs = customPairs || analysis?.pairs || [];
  const limitedText  = storyLimit && parseInt(storyLimit) > 0 ? truncateWords(article, parseInt(storyLimit)) : article;
  const limitedSegs  = storyLimit && parseInt(storyLimit) > 0 ? buildSegments(limitedText, analysis?.errors || []) : segments;
  const displayRw    = rwResult ? (rwDispLimit && parseInt(rwDispLimit) > 0 ? truncateWords(rwResult, parseInt(rwDispLimit)) : rwResult) : "";

  if (isInitializing) {
    return <div style={{ minHeight:"100vh", background:"#0D1117", color:"#E6EDF3", display:"flex", alignItems:"center", justifyContent:"center" }}>Loading DB Workspace...</div>;
  }

  return (
    <div style={{ minHeight:"100vh", background:"#0D1117", color:"#E6EDF3", fontFamily:"'Inter',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+Devanagari:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#161B22}::-webkit-scrollbar-thumb{background:#30363D;border-radius:3px}

        .tab{background:none;border:none;cursor:pointer;padding:10px 18px;font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;transition:all .2s;border-bottom:2px solid transparent;color:#6E7681;white-space:nowrap}
        .tab.on{color:#E6EDF3;border-bottom-color:#C8102E;background:#1C2128}
        .tab:hover:not(.on){color:#C9D1D9;background:#161B22}

        .main-tab{font-size:13px; padding:16px 20px; font-weight:600; color:#8B949E; border-bottom: 3px solid transparent; cursor:pointer;}
        .main-tab.on{color:#fff; border-bottom-color:#1F6FEB;}

        .btn-red{background:linear-gradient(135deg,#C8102E,#E53E3E);color:#fff;border:none;padding:9px 22px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
        .btn-red:hover:not(:disabled){filter:brightness(1.15);transform:translateY(-1px);box-shadow:0 4px 14px rgba(200,16,46,.4)}
        .btn-red:disabled{opacity:.38;cursor:not-allowed}

        .btn-blue{background:linear-gradient(135deg,#1F6FEB,#388BFD);color:#fff;border:none;padding:9px 22px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
        .btn-blue:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 4px 14px rgba(31,111,235,.4)}
        .btn-blue:disabled{opacity:.38;cursor:not-allowed}

        .btn-g{background:transparent;color:#8B949E;border:1px solid #30363D;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .18s;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
        .btn-g:hover:not(:disabled){background:#21262D;border-color:#58A6FF;color:#58A6FF}
        .btn-g:disabled{opacity:.35;cursor:not-allowed}

        .btn-sm{background:none;border:1px solid #30363D;color:#6E7681;padding:3px 9px;border-radius:4px;font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}
        .btn-sm:hover{border-color:#388BFD;color:#58A6FF}

        .inp{background:#161B22;border:1.5px solid #30363D;border-radius:8px;color:#E6EDF3;font-size:16px;line-height:2.1;padding:16px 18px;font-family:'Noto Serif Devanagari',serif;resize:vertical;outline:none;transition:border-color .2s;width:100%}
        .inp:focus{border-color:#C8102E;box-shadow:0 0 0 3px rgba(200,16,46,.1)}
        .inp::placeholder{color:#3D444D}

        .tinp{background:#161B22;border:1px solid #30363D;border-radius:6px;color:#E6EDF3;font-size:13px;line-height:1.6;padding:9px 13px;font-family:'Inter',sans-serif;resize:none;outline:none;transition:border-color .2s;width:100%}
        .tinp:focus{border-color:#388BFD}.tinp::placeholder{color:#3D444D}

        .ninp{background:#161B22;border:1px solid #30363D;border-radius:6px;color:#E6EDF3;font-size:12px;padding:7px 11px;outline:none;font-family:'Inter',sans-serif;width:80px;transition:border-color .2s;-moz-appearance:textfield}
        .ninp:focus{border-color:#388BFD}.ninp::-webkit-inner-spin-button,.ninp::-webkit-outer-spin-button{-webkit-appearance:none}

        .card{background:#161B22;border:1px solid #21262D;border-radius:10px}
        .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#6E7681}
        .divider{height:1px;background:#21262D;margin:16px 0}

        .pair-card{background:#0D1117;border:1px solid #21262D;border-radius:8px;overflow:hidden;margin-bottom:10px;transition:border-color .15s}
        .pair-card:hover{border-color:#30363D}
        .pair-head{padding:12px 14px 8px;border-bottom:1px solid #21262D}
        .pair-sub{padding:9px 14px 12px;background:#0A0E14}

        .score-bar{height:3px;background:#21262D;border-radius:2px;margin-top:6px;overflow:hidden}
        .score-fill{height:100%;border-radius:2px;transition:width .7s ease}

        .err-w{color:#FF6B6B;background:rgba(255,107,107,.12);border-bottom:2px solid #FF4444;border-radius:3px 3px 0 0;padding:0 2px;cursor:help;font-weight:600}
        .err-b{color:#484F58;font-size:.9em}
        .err-f{color:#4ADE80;background:rgba(74,222,128,.1);border-bottom:2px solid #22C55E;border-radius:3px 3px 0 0;padding:0 2px;font-weight:700}
        
        .fact-w{color:#F59E0B; background:rgba(245,158,11,.12); border-left:3px solid #F59E0B; padding:10px 14px; border-radius:4px; margin-bottom:10px;}

        .rw-panel{background:#0D1117;border:1px solid #21262D;border-top:none;border-radius:0 0 10px 10px;overflow:hidden;animation:slideDown .25s ease}
        @keyframes slideDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .spin{width:13px;height:13px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
        .spin-lg{width:26px;height:26px;border:2.5px solid #21262D;border-top-color:#C8102E;border-radius:50%;animation:spin .7s linear infinite}

        .tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:.3px}
        .ver-item{padding:8px 12px;border-bottom:1px solid #21262D;display:flex;justify-content:space-between;align-items:center;gap:10;font-size:12px}
        .ver-item:hover{background:#161B22}
        .ver-item:last-child{border-bottom:none}
        
        .inbox-list::-webkit-scrollbar { width: 4px; }
        .inbox-item { padding: 16px; border-bottom: 1px solid #21262D; cursor: pointer; transition: background 0.2s; }
        .inbox-item:hover { background: #1C2128; }
        .inbox-item.active { background: #1C2128; border-left: 3px solid #1F6FEB; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background:"#161B22", borderBottom:"1px solid #21262D", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ maxWidth:1100, margin:"0 auto", padding:"0 28px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          
          <div style={{ display:"flex", alignItems:"center", gap:24 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 0" }}>
              <div style={{ width:32, height:32, background:"linear-gradient(135deg,#C8102E,#8B0000)", borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>📰</div>
              <div>
                <div style={{ fontWeight:800, fontSize:14, color:"#E6EDF3", letterSpacing:-.3 }}>Dainik Bhaskar NewsDesk Pro</div>
                <div style={{ fontSize:10, color:"#484F58", letterSpacing:.8, textTransform:"uppercase" }}>AI Reporter · Gemini Edition</div>
              </div>
            </div>

            <div style={{ display:"flex" }}>
              <div className={`main-tab ${mainTab === "editor" ? "on" : ""}`} onClick={() => setMainTab("editor")}>
                📝 Editor Studio
              </div>
              <div className={`main-tab ${mainTab === "inbox" ? "on" : ""}`} onClick={() => setMainTab("inbox")}>
                📱 Press Note / WhatsApp Inbox
                {inboxMessages.filter(m => m.status === 'unread').length > 0 && (
                  <span style={{background:"#EF4444", color:"white", borderRadius:"10px", padding:"2px 6px", fontSize:"10px", marginLeft:"6px"}}>
                    {inboxMessages.filter(m => m.status === 'unread').length}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
             {user && (
                <div style={{ fontSize:11, color:"#484F58", display:"flex", alignItems:"center", gap:6 }}>
                  <div style={{width:8, height:8, borderRadius:"50%", background:"#4ADE80"}}></div>
                  Agent: {user.uid.substring(0,6)}
                </div>
              )}
          </div>
        </div>
      </div>


      <div style={{ maxWidth:1100, margin:"0 auto", padding:"20px 28px" }}>
        
        {/* ─── TAB: WHATSAPP / PRESS NOTE INBOX ────────────────────────────────────────── */}
        {mainTab === "inbox" && (
          <div style={{ display:"flex", gap:16, height:"calc(100vh - 120px)", animation:"fadeIn .3s ease" }}>
            
            {/* Left Col: Message List */}
            <div className="card" style={{ width:"350px", display:"flex", flexDirection:"column", overflow:"hidden" }}>
              <div style={{ padding:"12px 16px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#0D1117" }}>
                <span className="lbl">Incoming Tips & Notes</span>
                <button className="btn-sm" onClick={simulateIncomingMessage}>+ Simulate</button>
              </div>
              <div className="inbox-list" style={{ flex:1, overflowY:"auto", background:"#161B22" }}>
                {inboxMessages.length === 0 ? (
                  <div style={{ padding:30, textAlign:"center", color:"#6E7681", fontSize:13 }}>
                    No messages yet.<br/><br/>Click '+ Simulate' to mock an incoming WhatsApp press note.
                  </div>
                ) : (
                  inboxMessages.map((msg) => (
                    <div 
                      key={msg.id} 
                      className={`inbox-item ${selectedMessage?.id === msg.id ? 'active' : ''}`}
                      onClick={() => processInboxMessage(msg)}
                    >
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                        <span style={{ fontSize:13, fontWeight:600, color:"#E6EDF3" }}>{msg.sender}</span>
                        <span style={{ fontSize:10, color:"#6E7681" }}>{new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                      </div>
                      <div style={{ fontSize:12, color:"#8B949E", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                        {msg.original_text}
                      </div>
                      <div style={{ marginTop:8 }}>
                        {msg.status === "unread" && <span className="tag" style={{ background:"#C8102E33", color:"#EF4444" }}>NEW</span>}
                        {msg.status === "processed" && <span className="tag" style={{ background:"#10B98133", color:"#10B981" }}>PROCESSED</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Right Col: Details & AI Processing */}
            <div className="card" style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
              {selectedMessage ? (
                <>
                  <div style={{ padding:"12px 16px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#0D1117" }}>
                    <span className="lbl">Message Details & AI Rewrite</span>
                    {selectedMessage.rewritten && (
                      <button className="btn-blue" style={{ padding:"6px 14px" }} onClick={useInboxStory}>
                        Use in Editor ➔
                      </button>
                    )}
                  </div>
                  <div style={{ flex:1, overflowY:"auto", padding:20 }}>
                    <div className="lbl" style={{ marginBottom:8, color:"#6E7681" }}>Original Forwarded Text</div>
                    <div style={{ padding:"14px", background:"#0D1117", border:"1px solid #30363D", borderRadius:6, fontSize:14, color:"#C9D1D9", marginBottom:20, whiteSpace:"pre-wrap" }}>
                      {selectedMessage.original_text}
                    </div>

                    <div className="lbl" style={{ marginBottom:8, color:"#1F6FEB" }}>Dainik Bhaskar AI Rewrite</div>
                    {inboxLoading ? (
                       <div style={{ padding:40, textAlign:"center" }}>
                          <div className="spin-lg" style={{ margin:"0 auto 16px" }} />
                          <div style={{ color:"#8B949E", fontSize:13 }}>Gemini AI is writing the news...</div>
                       </div>
                    ) : selectedMessage.rewritten ? (
                      <div style={{ padding:"18px", background:"#161B22", border:"1px solid #1F6FEB", borderLeft:"4px solid #1F6FEB", borderRadius:6, fontSize:16, lineHeight:1.8, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>
                        {selectedMessage.rewritten}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:"#6E7681", fontSize:14 }}>
                  Select a message from the left to view and process.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── TAB: EDITOR STUDIO ──────────────────────────────────────────────────────── */}
        {mainTab === "editor" && (
          <div style={{ animation:"fadeIn .3s ease" }}>
            
            {/* Version History */}
            {showVersions && versions.length > 0 && (
              <div className="card" style={{ marginBottom:16, animation:"fadeIn .2s ease", overflow:"hidden" }}>
                <div style={{ padding:"10px 14px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span className="lbl">Version History</span>
                  <button className="btn-sm" onClick={()=>setShowVersions(false)}>✕ Close</button>
                </div>
                {[...versions].reverse().map((v, i) => (
                  <div key={i} className="ver-item">
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ color:"#484F58", fontSize:11 }}>🕒 {v.time}</span>
                      <span style={{ color:"#8B949E" }}>{v.label}</span>
                      <span style={{ color:"#484F58" }}>— {countWords(v.text)} words</span>
                    </div>
                    <button className="btn-sm" onClick={()=>{ setArticle(v.text); setShowVersions(false); }}>Restore</button>
                  </div>
                ))}
              </div>
            )}

            {/* Editor Container */}
            <div className="card" style={{ marginBottom: rwOpen ? 0 : 16, borderRadius: rwOpen ? "10px 10px 0 0" : 10 }}>
              <div style={{ padding:20 }}>
                
                {/* Editor Header Tools */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <span className="lbl">Story Editor</span>
                    {analysis?.story_category && (
                      <span className="tag" style={{ background: CAT_COLORS[analysis.story_category]+"33", color: CAT_COLORS[analysis.story_category], border:`1px solid ${CAT_COLORS[analysis.story_category]}44` }}>
                        {analysis.story_category.toUpperCase()}
                      </span>
                    )}
                  </div>

                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:5, background:"#0D1117", border:`1px solid ${overLimit?"#7D2A2A":"#21262D"}`, borderRadius:20, padding:"3px 12px", fontSize:12, marginRight:8 }}>
                      <span style={{ fontWeight:700, color: overLimit?"#F87171":"#E6EDF3" }}>{words}</span>
                      <span style={{ color:"#484F58" }}>w</span>
                      {storyLimit && <><span style={{ color:"#30363D" }}>/</span><span style={{ color:"#484F58" }}>{storyLimit}</span></>}
                    </div>

                    <span className="lbl" style={{ color:"#484F58" }}>Limit</span>
                    <input type="number" className="ninp" placeholder="words" value={storyLimit} onChange={e=>setStoryLimit(e.target.value)} min="0" />
                    
                    <button className="btn-g" style={{ fontSize:11, padding:"5px 10px" }} onClick={translateToHindi} disabled={loading||!article.trim()}>
                      {loading && loadingMsg.includes("Translating") ? <><div className="spin" />...</> : "🌐 → Hindi"}
                    </button>
                    
                    <button className="btn-g" style={{ fontSize:11, padding:"5px 10px", borderColor: rwOpen?"#C8102E":"#30363D", color:rwOpen?"#C8102E":"#8B949E" }} onClick={()=>setRwOpen(o=>!o)}>
                      {rwOpen ? "✕ Close Rewrite" : "✍ Rewrite"}
                    </button>

                    {versions.length > 0 && (
                      <button className="btn-g" style={{ padding:"5px 10px", fontSize:11 }} onClick={()=>setShowVersions(v=>!v)}>🕒 {versions.length}</button>
                    )}
                    <button className="btn-g" style={{ padding:"5px 10px", fontSize:11 }} onClick={clearAll}>Clear</button>
                  </div>
                </div>

                <textarea 
                  className="inp" 
                  style={{ minHeight:240 }} 
                  value={article} 
                  onChange={e=>setArticle(e.target.value)} 
                  onKeyDown={e => (e.ctrlKey || e.metaKey) && e.key === "Enter" && analyse()}
                  placeholder="यहाँ अपना समाचार लिखें... (Hindi or English — write your news story here)" 
                  spellCheck={false} 
                />

                {apiError && (
                  <div style={{ marginTop:10, background:"#2D1117", border:"1px solid #7D2A2A", borderRadius:6, padding:"9px 14px", color:"#F87171", fontSize:13 }}>⚠ {apiError}</div>
                )}

                <div style={{ marginTop:12, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"#484F58" }}>Ctrl+Enter to analyse</span>
                  </div>
                  
                  {/* Action Buttons */}
                  <div style={{ display:"flex", gap:8 }}>
                    <input ref={fileRef} type="file" style={{ display:"none" }} accept="image/*,.pdf,.txt,.doc,.docx" onChange={handleFileInput} />
                    
                    <button className="btn-g" onClick={() => fileRef.current.click()} disabled={mediaLoading}>
                      {mediaLoading ? <><div className="spin" /> Reading File...</> : "📎 Upload Media"}
                    </button>
                    
                    <button className="btn-g" onClick={()=>{saveVersion(article,"Manual save"); }}>💾 Save</button>
                    
                    <button className="btn-red" onClick={analyse} disabled={loading||!article.trim()||mediaLoading}>
                      {loading && !loadingMsg.includes("Translating") ? <><div className="spin" />{loadingMsg}</> : <>⚡ Analyse Story</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Rewrite Panel (Inline Below Editor) */}
            {rwOpen && (
              <div className="rw-panel" style={{ marginBottom:16 }}>
                <div style={{ padding:"14px 20px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10, flexWrap:"wrap" }}>
                    <span className="lbl" style={{ color:"#C8102E" }}>Rewrite in DB Style</span>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:11, color:"#6E7681" }}>Max words</span>
                      <input type="number" className="ninp" placeholder="e.g. 300" value={rwLimit} onChange={e=>setRwLimit(e.target.value)} min="0" />
                    </div>
                  </div>
                  <textarea className="tinp" value={rwPrompt} onChange={e=>setRwPrompt(e.target.value)} placeholder="Instructions e.g. make it front-page worthy, focus on local reader..." rows={2} />
                  <div style={{ marginTop:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"#484F58" }}>Rewrites using Dainik Bhaskar editorial guidelines</span>
                    <button className="btn-blue" onClick={rewrite} disabled={rwLoading||!article.trim()}>
                      {rwLoading ? <><div className="spin" />Rewriting…</> : <>✍ Rewrite Story</>}
                    </button>
                  </div>
                </div>

                {rwResult && (
                  <div style={{ borderTop:"1px solid #21262D" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 20px", background:"#161B22", flexWrap:"wrap", gap:8 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <span style={{ fontSize:12, fontWeight:700, color:"#4ADE80", textTransform:"uppercase", letterSpacing:.6 }}>Rewritten</span>
                        <span style={{ fontSize:12, color:"#484F58" }}>{countWords(rwResult)} words</span>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <button className="btn-sm" onClick={()=>navigator.clipboard.writeText(rwResult)}>Copy</button>
                        <button className="btn-g" style={{ fontSize:11, padding:"4px 12px" }} onClick={()=>{saveVersion(article,"Before use rewrite"); setArticle(rwResult); setRwResult(null); setRwOpen(false);}}>Use This ↑</button>
                      </div>
                    </div>
                    <div style={{ padding:"18px 20px", fontSize:16, lineHeight:2.15, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>
                      {displayRw}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── RESULTS TABS ── */}
            {analysis && !loading && (
              <div className="card" style={{ overflow:"hidden", animation:"fadeIn .3s ease" }}>
                <div style={{ display:"flex", borderBottom:"1px solid #21262D", background:"#0D1117", overflowX:"auto" }}>
                  
                  <button className={`tab ${activeTab==="facts"?"on":""}`} onClick={()=>setActiveTab("facts")} style={{color: factCount > 0 ? "#F59E0B" : undefined}}>
                    Fact Checks
                    {factCount>0 && <span style={{ background: activeTab==="facts"?"#F59E0B":"#21262D", color: activeTab==="facts"?"#fff":"#F59E0B", borderRadius:20, padding:"1px 7px", fontSize:10, marginLeft:6, fontWeight:700 }}>{factCount}</span>}
                  </button>

                  <button className={`tab ${activeTab==="grammar"?"on":""}`} onClick={()=>setActiveTab("grammar")}>
                    Grammar
                    {errCount>0 && <span style={{ background:activeTab==="grammar"?"#CF222E":"#21262D", color:activeTab==="grammar"?"#fff":"#6E7681", borderRadius:20, padding:"1px 7px", fontSize:10, marginLeft:6, fontWeight:700 }}>{errCount}</span>}
                  </button>

                  <button className={`tab ${activeTab==="headlines"?"on":""}`} onClick={()=>setActiveTab("headlines")}>
                    Headlines
                    <span style={{ background:activeTab==="headlines"?"#C8102E":"#21262D", color:activeTab==="headlines"?"#fff":"#6E7681", borderRadius:20, padding:"1px 7px", fontSize:10, marginLeft:6, fontWeight:700 }}>{displayPairs.length}</span>
                  </button>

                  {analysis.missing_elements?.length > 0 && (
                    <button className={`tab ${activeTab==="missing"?"on":""}`} onClick={()=>setActiveTab("missing")} style={{ color: activeTab==="missing"?"#F87171":"#6E7681" }}>
                      ⚠ Missing
                    </button>
                  )}
                </div>

                <div style={{ padding:"22px 24px" }}>

                  {/* ── FACT CHECKS ── */}
                  {activeTab==="facts" && (
                    <div style={{ animation:"fadeIn .25s ease" }}>
                      <div className="lbl" style={{ marginBottom:14 }}>Fact & Consistency Analysis</div>
                      {factCount === 0 ? (
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ color:"#4ADE80", fontSize:16 }}>✓</span>
                          <span style={{ fontSize:13, color:"#4ADE80", fontWeight:600 }}>No factual inconsistencies detected between headline and body.</span>
                        </div>
                      ) : (
                        <div>
                          {analysis.fact_checks.map((fact, i) => (
                            <div key={i} className="fact-w">
                              <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:4}}>
                                <span style={{fontWeight:700, fontSize:13}}>⚠ Issue Detected</span>
                                {fact.severity && <span className="tag" style={{background:"#B45309", color:"#fff"}}>{fact.severity}</span>}
                              </div>
                              <div style={{fontSize:14, fontFamily:"'Inter',sans-serif", color:"#E6EDF3", marginBottom:6}}>{fact.issue}</div>
                              {fact.correction_suggestion && (
                                <div style={{fontSize:12, color:"#FBBF24"}}>Suggestion: {fact.correction_suggestion}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── GRAMMAR ── */}
                  {activeTab==="grammar" && (
                    <div style={{ animation:"fadeIn .25s ease" }}>
                      {analysis.summary && (
                        <div style={{ background:"#0D1117", border:"1px solid #21262D", borderLeft:"3px solid #C8102E", borderRadius:"0 8px 8px 0", padding:"12px 16px", marginBottom:18 }}>
                          <div className="lbl" style={{ color:"#C8102E", marginBottom:6 }}>Editorial Feedback</div>
                          <p style={{ fontSize:15, lineHeight:1.9, color:"#C9D1D9", fontFamily:"'Noto Serif Devanagari',serif" }}>{analysis.summary}</p>
                        </div>
                      )}
                      
                      {errCount > 0 ? (
                        <>
                          <div style={{ display:"flex", gap:14, marginBottom:14, alignItems:"center", flexWrap:"wrap" }}>
                            <span className="lbl">Legend:</span>
                            <span style={{ fontSize:13, fontFamily:"'Noto Serif Devanagari',serif" }}>
                              <span className="err-w" style={{ cursor:"default" }}>गलत</span>
                              <span className="err-b"> [</span><span className="err-f">सही</span><span className="err-b">]</span>
                            </span>
                            <span style={{ fontSize:11, color:"#484F58" }}>Hover red word for reason</span>
                          </div>
                          <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"18px 20px", fontSize:16, lineHeight:2.4, fontFamily:"'Noto Serif Devanagari',serif", color:"#E6EDF3", whiteSpace:"pre-wrap" }}>
                            {limitedSegs.map((seg,i) => {
                              if (seg.type==="normal") return <span key={i}>{seg.text}</span>;
                              return (
                                <span key={i} title={seg.explanation||""} style={{ cursor:"help" }}>
                                  <span className="err-w">{seg.original}</span>
                                  <span className="err-b"> [</span><span className="err-f">{seg.correction}</span><span className="err-b">] </span>
                                </span>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div>
                          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                            <span style={{ color:"#4ADE80", fontSize:16 }}>✓</span>
                            <span style={{ fontSize:13, color:"#4ADE80", fontWeight:600 }}>No grammar errors found</span>
                          </div>
                          <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"18px 20px", fontSize:16, lineHeight:2.2, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>{limitedText}</div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── HEADLINES & SUBHEADS ── */}
                  {activeTab==="headlines" && (
                    <div style={{ animation:"fadeIn .25s ease" }}>
                      <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"14px 16px", marginBottom:18 }}>
                        <div className="lbl" style={{ marginBottom:10 }}>Headline Generator Settings</div>
                        <div style={{ display:"flex", gap:10, marginBottom:10, flexWrap:"wrap", alignItems:"center" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                            <span style={{ fontSize:11, color:"#6E7681" }}>Headline limit</span>
                            <input type="number" className="ninp" placeholder="words" value={hlHeadLimit} onChange={e=>setHlHeadLimit(e.target.value)} min="0" />
                          </div>
                          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                            <span style={{ fontSize:11, color:"#6E7681" }}>Sub-headline limit</span>
                            <input type="number" className="ninp" placeholder="words" value={hlSubLimit} onChange={e=>setHlSubLimit(e.target.value)} min="0" />
                          </div>
                        </div>
                        <textarea className="tinp" value={hlPrompt} onChange={e=>setHlPrompt(e.target.value)} placeholder="Custom instruction e.g. dramatic tone, political angle, Madhya Pradesh audience..." rows={2} />
                        <div style={{ marginTop:10, display:"flex", justifyContent:"flex-end" }}>
                          <button className="btn-red" onClick={genHeadlines} disabled={hlLoading||!article.trim()}>
                            {hlLoading ? <><div className="spin" />Generating…</> : <>⚡ Regenerate Pairs</>}
                          </button>
                        </div>
                      </div>

                      {customPairs && (
                        <div style={{ background:"#1C2128", border:"1px solid #C8102E33", borderRadius:6, padding:"7px 12px", marginBottom:14, fontSize:12, color:"#C8102E" }}>
                          ✦ Custom pairs based on your settings
                        </div>
                      )}

                      <div className="lbl" style={{ marginBottom:12 }}>Headline + Sub-Headline Pairs ({displayPairs.length})</div>

                      {displayPairs.map((p,i) => {
                        const sc = STYLE_COLORS[p.style]||"#30363D";
                        const scoreColor = p.score>=80?"#4ADE80":p.score>=60?"#FBBF24":"#F87171";
                        const scoreBg = p.score>=80?"linear-gradient(90deg,#238636,#4ADE80)":p.score>=60?"linear-gradient(90deg,#9A6700,#FBBF24)":"linear-gradient(90deg,#7D2A2A,#F87171)";
                        const headText = hlHeadLimit&&parseInt(hlHeadLimit)>0 ? truncateWords(p.headline,parseInt(hlHeadLimit)) : p.headline;
                        const subText  = hlSubLimit&&parseInt(hlSubLimit)>0   ? truncateWords(p.subheadline,parseInt(hlSubLimit)) : p.subheadline;
                        return (
                          <div key={i} className="pair-card">
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 14px 0", background:"#0D1117" }}>
                              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                                <span style={{ fontSize:11, color:"#484F58" }}>#{i+1}</span>
                                <span style={{ display:"inline-block", padding:"2px 7px", borderRadius:4, fontSize:10, fontWeight:700, color:"#fff", background:sc, letterSpacing:.3 }}>{p.style||"standard"}</span>
                                {p.angle && <span style={{ fontSize:10, color:"#8B949E", background:"#21262D", borderRadius:4, padding:"2px 7px" }}>{p.angle}</span>}
                              </div>
                              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                                <span style={{ fontSize:12, fontWeight:700, color:scoreColor }}>{p.score}</span>
                                <button className="btn-sm" onClick={()=>navigator.clipboard.writeText(p.headline+"\n"+p.subheadline)}>Copy Both</button>
                              </div>
                            </div>
                            <div className="pair-head">
                              <div style={{ fontSize:10, color:"#6E7681", fontWeight:700, textTransform:"uppercase", letterSpacing:.8, marginBottom:5 }}>Headline</div>
                              <div style={{ fontSize:17, lineHeight:1.65, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", fontWeight:700, display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
                                <span>{headText}</span>
                                <button className="btn-sm" style={{ flexShrink:0, marginTop:2 }} onClick={()=>navigator.clipboard.writeText(p.headline)}>Copy</button>
                              </div>
                              <div className="score-bar"><div className="score-fill" style={{ width:`${p.score}%`, background:scoreBg }} /></div>
                            </div>
                            <div className="pair-sub">
                              <div style={{ fontSize:10, color:"#484F58", fontWeight:700, textTransform:"uppercase", letterSpacing:.8, marginBottom:5 }}>Sub-Headline</div>
                              <div style={{ fontSize:14, lineHeight:1.75, color:"#8B949E", fontFamily:"'Noto Serif Devanagari',serif", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
                                <span>{subText}</span>
                                <button className="btn-sm" style={{ flexShrink:0, marginTop:2 }} onClick={()=>navigator.clipboard.writeText(p.subheadline)}>Copy</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── MISSING ELEMENTS ── */}
                  {activeTab==="missing" && analysis.missing_elements && (
                    <div style={{ animation:"fadeIn .25s ease" }}>
                      <div style={{ marginBottom:14, fontSize:13, color:"#8B949E" }}>These journalistic elements are missing or weak in your story — consider adding them.</div>
                      {analysis.missing_elements.map((m,i) => (
                        <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", background:"#0D1117", border:"1px solid #21262D", borderLeft:"3px solid #F87171", borderRadius:"0 6px 6px 0", marginBottom:8 }}>
                          <span style={{ color:"#F87171", fontWeight:700, fontSize:14, marginTop:1 }}>⚠</span>
                          <span style={{ fontSize:14, color:"#C9D1D9", fontFamily:"'Noto Serif Devanagari',serif", lineHeight:1.7 }}>{m}</span>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}