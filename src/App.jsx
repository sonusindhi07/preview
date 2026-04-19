import { useState, useRef, useCallback, useEffect } from "react";

// ─── DB STYLE ────────────────────────────────────────────────────────────────
const DB_STYLE = `DAINIK BHASKAR EDITORIAL STYLE (MANDATORY):
1. LEAD: Answer कौन/क्या/कहाँ/कब/क्यों in first 2-3 lines. Most important fact FIRST (inverted pyramid).
2. LANGUAGE: Simple Khari Boli Hindi. Short sentences ≤20 words. Active voice. No heavy Sanskrit/Urdu jargon.
3. TONE: Authoritative, accessible, never sensational. Facts-first. No opinion unless attributed.
4. STRUCTURE: Lead → Key facts → Background → Quote → Impact/What next.
5. NUMBERS: Always digits (5 not पाँच). ₹ symbol. % for percentages.
6. ATTRIBUTION: Every claim needs source — "पुलिस के अनुसार", "अधिकारियों ने बताया".
7. QUOTES: Direct quotes from named sources only. In quotation marks.
8. LOCAL CONNECT: Make story relevant to reader's daily life.
9. AVOID: Redundancy, passive voice, vague phrases ("कुछ लोग", unnamed "सूत्र").
10. If facts are missing, write [FACT NEEDED] — never invent.`;

// ─── PROMPTS ─────────────────────────────────────────────────────────────────
const ANALYSIS_PROMPT = `You are an expert Hindi language editor for Dainik Bhaskar newspaper.

FONT-ENCODING RULES (STRICT — never flag these):
- अा vs आ, ाे/ाै vs ो/ौ, िव vs वि, मंे vs में — same word, different encoding. IGNORE completely.
- Only flag genuine grammar or wrong-letter spelling mistakes. When in doubt, do NOT flag.

CONSISTENCY CHECK — CRITICAL:
Also check for factual consistency between headline/subheadline and body text:
- Numbers in headline vs body (e.g. headline says 10000 but body says 100 → flag it)
- Names in headline vs body (e.g. headline says "राम" but body says "श्याम" → flag it)
- Dates, amounts, percentages that differ between headline and content
- Any factual contradiction between title and story body
Report these as type "consistency" errors.

Respond ONLY with a valid JSON object. No markdown, no backticks.
{
  "errors": [ { "original": "exact substring or description", "correction": "corrected form", "explanation": "short reason", "type": "grammar|spelling|consistency" } ],
  "pairs": [ { "headline": "Hindi headline", "subheadline": "matching sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "angle": "one word", "score": 90 } ],
  "summary": "2-3 sentence editorial feedback in Hindi",
  "seo_keywords": ["kw1","kw2","kw3"],
  "story_category": "politics|crime|sports|health|business|local|national|international|entertainment",
  "missing_elements": ["missing element description if any"]
}
Rules: EXACTLY 20 pairs. Score 1-100. Escape double-quotes as \\". No trailing commas.`;

const HEADLINES_PROMPT = `You are a senior Dainik Bhaskar headline writer.
Generate exactly 20 headline+subheadline pairs. Enforce word limits if specified.
Respond ONLY with valid JSON (no markdown):
{ "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "angle": "one word", "score": 90 } ] }
Score 1-100. Escape double-quotes as \\".`;

const REWRITE_PROMPT = `You are a senior state editor at Dainik Bhaskar.
${DB_STYLE}
If word count is specified, stay within that limit strictly.
Respond ONLY with valid JSON (no markdown): { "rewritten": "full DB-style Hindi article" }
Escape double-quotes as \\".`;

const MEDIA_TO_NEWS_PROMPT = `You are a senior reporter at Dainik Bhaskar.
${DB_STYLE}
Extract all factual information from the provided content (press note / image / document).
If content is in English, translate and rewrite in Hindi.
Generate a full DB-style Hindi news article AND 5 headline+subheadline pairs.
Respond ONLY with valid JSON (no markdown):
{
  "article": "complete Hindi news article",
  "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "score": 90 } ],
  "summary": "brief note about source in English",
  "detected_language": "Hindi|English|Mixed|Other",
  "key_facts": ["fact1","fact2","fact3"]
}
Escape double-quotes as \\". No trailing commas.`;

const PRESSNOTE_PROMPT = `You are a senior reporter at Dainik Bhaskar.
${DB_STYLE}
You have received a raw press note or forwarded WhatsApp message (may be in Hindi or English or mixed).
Your tasks:
1. Identify ALL key facts, names, numbers, dates, locations from the source.
2. Write a complete professional DB-style Hindi news article.
3. Generate 5 headline+subheadline pairs.
4. List any facts that need verification.

Respond ONLY with valid JSON (no markdown):
{
  "article": "complete DB-style Hindi news article",
  "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "score": 90 } ],
  "key_facts": ["fact1","fact2"],
  "verify_needed": ["item that needs verification"],
  "source_type": "press_note|whatsapp|email|other",
  "detected_language": "Hindi|English|Mixed"
}
Escape double-quotes as \\". No trailing commas.`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function buildSegments(text, errors) {
  if (!errors || errors.length === 0) return [{ type: "normal", text }];
  const positioned = [], used = [];
  for (const err of errors) {
    if (!err.original) continue;
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
}

function extractJSON(raw) {
  let s = raw.replace(/```json|```/gi, "").trim();
  try { return JSON.parse(s); } catch (_) {}
  const st = s.indexOf("{"), en = s.lastIndexOf("}");
  if (st !== -1 && en !== -1) { try { return JSON.parse(s.slice(st, en + 1)); } catch (_) {} }
  return null;
}

// ─── GEMINI API CALL ─────────────────────────────────────────────────────────
async function callGemini(apiKey, systemPrompt, userContent, imageParts = []) {
  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [];
  if (imageParts.length > 0) parts.push(...imageParts);
  parts.push({ text: userContent });

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.3 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  const parsed = extractJSON(raw);
  if (!parsed) throw new Error("Could not parse Gemini response. Please retry.");
  return parsed;
}

const countWords = t => t.trim() ? t.trim().split(/\s+/).length : 0;
const truncateWords = (t, n) => { const w = t.trim().split(/\s+/); return w.length <= n ? t : w.slice(0, n).join(" ") + "…"; };

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("File read failed"));
    r.readAsDataURL(file);
  });
}

const STYLE_COLORS = {
  breaking:"#EF4444", informative:"#3B82F6", dramatic:"#8B5CF6",
  soft:"#10B981", question:"#F59E0B", statistic:"#06B6D4"
};
const CAT_COLORS = {
  politics:"#EF4444", crime:"#F97316", sports:"#10B981", health:"#06B6D4",
  business:"#3B82F6", local:"#8B5CF6", national:"#F59E0B", international:"#EC4899", entertainment:"#14B8A6"
};

const STEPS = [
  { label: "Reading content", pct: 15 },
  { label: "Checking grammar & consistency", pct: 35 },
  { label: "Generating headlines", pct: 60 },
  { label: "Analysing journalistic quality", pct: 80 },
  { label: "Finalising", pct: 95 },
];

// ─── API KEY GATE ─────────────────────────────────────────────────────────────
function ApiKeyGate({ onSave }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState(false);

  const test = async () => {
    if (!key.trim()) { setErr("Please enter your API key."); return; }
    setTesting(true); setErr("");
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key.trim()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with just: OK" }] }] })
      });
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error?.message || "Invalid API key"); }
      onSave(key.trim());
    } catch(e) { setErr(`❌ ${e.message}`); }
    finally { setTesting(false); }
  };

  return (
    <div style={{ minHeight:"100vh", background:"#0D1117", display:"flex", alignItems:"center", justifyContent:"center", padding:24, fontFamily:"'Inter',sans-serif" }}>
      <div style={{ maxWidth:520, width:"100%", animation:"fadeIn .4s ease" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ width:56, height:56, background:"linear-gradient(135deg,#C8102E,#8B0000)", borderRadius:14, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, margin:"0 auto 16px" }}>📰</div>
          <div style={{ fontSize:22, fontWeight:800, color:"#E6EDF3", marginBottom:6 }}>Dainik Bhaskar NewsDesk</div>
          <div style={{ fontSize:13, color:"#6E7681" }}>AI-Powered Reporter & Editor Suite</div>
        </div>

        <div style={{ background:"#161B22", border:"1px solid #21262D", borderRadius:12, padding:28 }}>
          <div style={{ fontSize:14, fontWeight:700, color:"#E6EDF3", marginBottom:4 }}>Enter your Gemini API Key</div>
          <div style={{ fontSize:12, color:"#6E7681", marginBottom:20, lineHeight:1.6 }}>
            This app uses Google Gemini AI. Your key is stored only in your browser session and never sent to any server.
          </div>

          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:"#6E7681", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>Gemini API Key</div>
            <div style={{ position:"relative" }}>
              <input
                type={show ? "text" : "password"}
                value={key}
                onChange={e => setKey(e.target.value)}
                onKeyDown={e => e.key === "Enter" && test()}
                placeholder="AIza..."
                style={{ width:"100%", background:"#0D1117", border:"1.5px solid #30363D", borderRadius:8, color:"#E6EDF3", fontSize:14, padding:"10px 44px 10px 14px", outline:"none", fontFamily:"monospace", transition:"border-color .2s" }}
              />
              <button onClick={()=>setShow(s=>!s)} style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", fontSize:16, color:"#6E7681" }}>
                {show ? "🙈" : "👁"}
              </button>
            </div>
          </div>

          {err && <div style={{ background:"#2D1117", border:"1px solid #7D2A2A", borderRadius:6, padding:"9px 12px", color:"#F87171", fontSize:13, marginBottom:12 }}>{err}</div>}

          <button onClick={test} disabled={testing || !key.trim()} style={{ width:"100%", background:"linear-gradient(135deg,#C8102E,#E53E3E)", color:"#fff", border:"none", padding:"11px 0", borderRadius:8, fontSize:14, fontWeight:700, cursor:testing||!key.trim()?"not-allowed":"pointer", opacity:testing||!key.trim()?.4:1, fontFamily:"'Inter',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            {testing ? <><div style={{ width:14, height:14, border:"2px solid rgba(255,255,255,.3)", borderTopColor:"#fff", borderRadius:"50%", animation:"spin .7s linear infinite" }} />Verifying…</> : "→ Connect & Enter NewsDesk"}
          </button>

          <div style={{ marginTop:20, background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"14px 16px" }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#6E7681", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>How to get your API key</div>
            {[
              ["1", "Go to", "aistudio.google.com", "https://aistudio.google.com"],
              ["2", "Sign in with your Google account", "", ""],
              ["3", "Click 'Get API Key' → 'Create API key'", "", ""],
              ["4", "Copy the key and paste it above", "", ""],
            ].map(([n, text, link, href], i) => (
              <div key={i} style={{ display:"flex", gap:8, marginBottom:6, fontSize:12, color:"#8B949E", alignItems:"flex-start" }}>
                <span style={{ background:"#21262D", color:"#6E7681", borderRadius:"50%", width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, flexShrink:0 }}>{n}</span>
                <span>{text} {link && <a href={href} target="_blank" rel="noreferrer" style={{ color:"#388BFD", textDecoration:"none" }}>{link}</a>}</span>
              </div>
            ))}
            <div style={{ marginTop:10, fontSize:11, color:"#484F58", lineHeight:1.5 }}>⚡ Free tier: 1500 requests/day · Gemini 2.0 Flash model · No credit card needed</div>
          </div>
        </div>
      </div>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── PROGRESS BAR ────────────────────────────────────────────────────────────
function ProgressBar({ progress, label }) {
  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
        <span style={{ fontSize:13, color:"#8B949E", fontFamily:"'Inter',sans-serif" }}>{label}</span>
        <span style={{ fontSize:12, color:"#58A6FF", fontWeight:700, fontFamily:"'Inter',sans-serif" }}>{progress}%</span>
      </div>
      <div style={{ height:6, background:"#21262D", borderRadius:3, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${progress}%`, background:"linear-gradient(90deg,#C8102E,#E53E3E)", borderRadius:3, transition:"width .4s ease", boxShadow:"0 0 8px rgba(200,16,46,.5)" }} />
      </div>
      <div style={{ display:"flex", gap:6, marginTop:12, flexWrap:"wrap" }}>
        {STEPS.map((s, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:4, fontSize:11, fontFamily:"'Inter',sans-serif", color: progress >= s.pct ? "#4ADE80" : "#484F58" }}>
            <span>{progress >= s.pct ? "✓" : "○"}</span>
            <span>{s.label}</span>
            {i < STEPS.length-1 && <span style={{ color:"#21262D", marginLeft:4 }}>·</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PAIR CARD ────────────────────────────────────────────────────────────────
function PairCard({ p, i, hlHeadLimit, hlSubLimit }) {
  const sc = STYLE_COLORS[p.style] || "#30363D";
  const scoreColor = p.score>=80?"#4ADE80":p.score>=60?"#FBBF24":"#F87171";
  const scoreBg = p.score>=80?"linear-gradient(90deg,#238636,#4ADE80)":p.score>=60?"linear-gradient(90deg,#9A6700,#FBBF24)":"linear-gradient(90deg,#7D2A2A,#F87171)";
  const headText = hlHeadLimit&&parseInt(hlHeadLimit)>0 ? truncateWords(p.headline,parseInt(hlHeadLimit)) : p.headline;
  const subText  = hlSubLimit&&parseInt(hlSubLimit)>0   ? truncateWords(p.subheadline,parseInt(hlSubLimit)) : p.subheadline;
  const copy = t => navigator.clipboard.writeText(t);
  return (
    <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, overflow:"hidden", marginBottom:10, transition:"border-color .15s" }}
      onMouseEnter={e=>e.currentTarget.style.borderColor="#30363D"}
      onMouseLeave={e=>e.currentTarget.style.borderColor="#21262D"}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 14px 6px", background:"#0A0E14" }}>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <span style={{ fontSize:11, color:"#484F58" }}>#{i+1}</span>
          <span style={{ padding:"2px 7px", borderRadius:4, fontSize:10, fontWeight:700, color:"#fff", background:sc }}>{p.style||"standard"}</span>
          {p.angle && <span style={{ fontSize:10, color:"#8B949E", background:"#21262D", borderRadius:4, padding:"2px 6px" }}>{p.angle}</span>}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ fontSize:12, fontWeight:700, color:scoreColor }}>{p.score}</span>
          <button onClick={()=>copy(p.headline+"\n"+p.subheadline)} style={{ background:"none", border:"1px solid #30363D", color:"#6E7681", padding:"2px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontFamily:"'Inter',sans-serif" }}>Copy Both</button>
        </div>
      </div>
      <div style={{ padding:"10px 14px 8px", borderBottom:"1px solid #21262D" }}>
        <div style={{ fontSize:10, color:"#6E7681", fontWeight:700, textTransform:"uppercase", letterSpacing:.8, marginBottom:5 }}>Headline</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
          <span style={{ fontSize:17, lineHeight:1.65, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", fontWeight:700 }}>{headText}</span>
          <button onClick={()=>copy(p.headline)} style={{ background:"none", border:"1px solid #30363D", color:"#6E7681", padding:"2px 7px", borderRadius:4, fontSize:10, cursor:"pointer", flexShrink:0, fontFamily:"'Inter',sans-serif" }}>Copy</button>
        </div>
        <div style={{ height:3, background:"#21262D", borderRadius:2, marginTop:8, overflow:"hidden" }}>
          <div style={{ height:"100%", width:`${p.score}%`, background:scoreBg, borderRadius:2, transition:"width .7s ease" }} />
        </div>
      </div>
      <div style={{ padding:"8px 14px 12px", background:"#080C12" }}>
        <div style={{ fontSize:10, color:"#484F58", fontWeight:700, textTransform:"uppercase", letterSpacing:.8, marginBottom:5 }}>Sub-Headline</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
          <span style={{ fontSize:14, lineHeight:1.75, color:"#8B949E", fontFamily:"'Noto Serif Devanagari',serif" }}>{subText}</span>
          <button onClick={()=>copy(p.subheadline)} style={{ background:"none", border:"1px solid #30363D", color:"#6E7681", padding:"2px 7px", borderRadius:4, fontSize:10, cursor:"pointer", flexShrink:0, fontFamily:"'Inter',sans-serif" }}>Copy</button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("db_gemini_key") || "");

  const [article, setArticle]     = useState("");
  const [analysis, setAnalysis]   = useState(null);
  const [segments, setSegments]   = useState([]);
  const [progress, setProgress]   = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [loading, setLoading]     = useState(false);
  const [apiError, setApiError]   = useState(null);
  const [activeTab, setActiveTab] = useState("grammar");

  const [storyLimit, setStoryLimit] = useState("");

  const [hlPrompt, setHlPrompt]       = useState("");
  const [hlHeadLimit, setHlHeadLimit] = useState("");
  const [hlSubLimit, setHlSubLimit]   = useState("");
  const [hlLoading, setHlLoading]     = useState(false);
  const [customPairs, setCustomPairs] = useState(null);

  const [rwOpen, setRwOpen]         = useState(false);
  const [rwPrompt, setRwPrompt]     = useState("");
  const [rwLimit, setRwLimit]       = useState("");
  const [rwLoading, setRwLoading]   = useState(false);
  const [rwResult, setRwResult]     = useState(null);
  const [rwDispLimit, setRwDispLimit] = useState("");

  const [mediaLoading, setMediaLoading] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [mediaResult, setMediaResult]   = useState(null);

  const [pressnote, setPressnote]       = useState("");
  const [pressnoteLoading, setPressnoteLoading] = useState(false);
  const [pressnoteResult, setPressnoteResult]   = useState(null);
  const [pressnoteProgress, setPressnoteProgress] = useState(0);

  const [transLoading, setTransLoading] = useState(false);

  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);

  const editorRef = useRef(null);
  const fileRef   = useRef(null);
  const progressTimer = useRef(null);

  const saveKey = k => { sessionStorage.setItem("db_gemini_key", k); setApiKey(k); };
  const logout  = () => { sessionStorage.removeItem("db_gemini_key"); setApiKey(""); };

  const saveVersion = useCallback((text, label) => {
    if (!text.trim()) return;
    setVersions(v => [...v.slice(-9), { text, label, time: new Date().toLocaleTimeString("en-IN") }]);
  }, []);

  const animateProgress = useCallback((from, to, durationMs, label) => {
    setProgressLabel(label);
    const steps = 20, stepTime = durationMs / steps;
    let current = from, i = 0;
    clearInterval(progressTimer.current);
    progressTimer.current = setInterval(() => {
      i++; current = from + ((to - from) * i / steps);
      setProgress(Math.round(current));
      if (i >= steps) clearInterval(progressTimer.current);
    }, stepTime);
  }, []);

  const clearAll = () => {
    setArticle(""); setAnalysis(null); setSegments([]);
    setCustomPairs(null); setRwResult(null); setMediaResult(null); setPressnoteResult(null);
    setApiError(null); setStoryLimit(""); setHlPrompt(""); setHlHeadLimit(""); setHlSubLimit("");
    setRwPrompt(""); setRwLimit(""); setRwDispLimit(""); setUploadedFile(null);
    setRwOpen(false); setShowVersions(false); setProgress(0); setPressnote("");
  };

  // ── Analyse ──
  const analyse = useCallback(async () => {
    if (article.trim().length < 20) { setApiError("Please write at least 20 characters."); return; }
    setLoading(true); setApiError(null); setAnalysis(null); setSegments([]); setCustomPairs(null); setRwResult(null);
    setProgress(0);
    try {
      animateProgress(0, 15, 600, "Reading story…");
      await new Promise(r=>setTimeout(r,600));
      animateProgress(15, 55, 1200, "Checking grammar & consistency…");
      const parsed = await callGemini(apiKey, ANALYSIS_PROMPT, `Analyse this Hindi news article:\n\n${article}`);
      animateProgress(55, 85, 600, "Generating headlines…");
      await new Promise(r=>setTimeout(r,600));
      animateProgress(85, 100, 400, "Done!");
      await new Promise(r=>setTimeout(r,400));
      setAnalysis(parsed);
      setSegments(buildSegments(article, parsed.errors || []));
      setActiveTab("grammar");
    } catch (e) { setApiError(`Error: ${e.message}`); }
    finally { setLoading(false); clearInterval(progressTimer.current); }
  }, [article, apiKey, animateProgress]);

  // ── Rewrite ──
  const rewrite = useCallback(async () => {
    if (!article.trim()) return;
    saveVersion(article, "Before rewrite");
    setRwLoading(true); setApiError(null); setRwResult(null);
    try {
      let instr = rwPrompt.trim() || "Rewrite in professional Dainik Bhaskar style.";
      if (rwLimit) instr += ` STRICT word limit: max ${rwLimit} words.`;
      const parsed = await callGemini(apiKey, REWRITE_PROMPT, `Article:\n\n${article}\n\nInstruction: ${instr}`);
      setRwResult(parsed.rewritten || "");
      setRwDispLimit(rwLimit);
    } catch (e) { setApiError(`Rewrite Error: ${e.message}`); }
    finally { setRwLoading(false); }
  }, [article, rwPrompt, rwLimit, apiKey, saveVersion]);

  // ── Custom Headlines ──
  const genHeadlines = useCallback(async () => {
    if (!article.trim()) return;
    setHlLoading(true); setApiError(null);
    try {
      let instr = hlPrompt.trim() || "Generate 20 best pairs.";
      if (hlHeadLimit) instr += ` Each headline max ${hlHeadLimit} words.`;
      if (hlSubLimit)  instr += ` Each sub-headline max ${hlSubLimit} words.`;
      const parsed = await callGemini(apiKey, HEADLINES_PROMPT, `Article:\n\n${article}\n\nInstruction: ${instr}`);
      setCustomPairs(parsed.pairs || []);
    } catch (e) { setApiError(`Headlines Error: ${e.message}`); }
    finally { setHlLoading(false); }
  }, [article, hlPrompt, hlHeadLimit, hlSubLimit, apiKey]);

  // ── Media upload ──
  const processMedia = useCallback(async (file) => {
    setMediaLoading(true); setApiError(null); setMediaResult(null); setUploadedFile(file);
    try {
      const isImage = file.type.startsWith("image/");
      const isPDF   = file.type === "application/pdf";
      let imageParts = [];
      let userText = "";
      if (isImage) {
        const b64 = await toBase64(file);
        imageParts = [{ inline_data: { mime_type: file.type, data: b64 } }];
        userText = "Read all content from this image and generate a DB-style Hindi news article.";
      } else if (isPDF) {
        const b64 = await toBase64(file);
        imageParts = [{ inline_data: { mime_type: "application/pdf", data: b64 } }];
        userText = "Extract all content from this PDF and generate a DB-style Hindi news article.";
      } else {
        const text = await file.text().catch(() => `[File: ${file.name}]`);
        userText = `Extract news from this content and write a DB-style Hindi article:\n\nFilename: ${file.name}\n\n${text}`;
      }
      const parsed = await callGemini(apiKey, MEDIA_TO_NEWS_PROMPT, userText, imageParts);
      setMediaResult(parsed);
    } catch (e) { setApiError(`Media Error: ${e.message}`); }
    finally { setMediaLoading(false); }
  }, [apiKey]);

  // ── Translate → Hindi ──
  const translateToHindi = useCallback(async () => {
    if (!article.trim()) return;
    setTransLoading(true); setApiError(null);
    try {
      const TRANS = `You are a professional Hindi translator at Dainik Bhaskar. Translate and rewrite as DB-style Hindi news. ${DB_STYLE} Respond ONLY with JSON: { "article": "DB-style Hindi article" } Escape double-quotes as \\".`;
      const parsed = await callGemini(apiKey, TRANS, `Translate and rewrite:\n\n${article}`);
      if (parsed.article) { saveVersion(article,"Before translation"); setArticle(parsed.article); }
    } catch (e) { setApiError(`Translation Error: ${e.message}`); }
    finally { setTransLoading(false); }
  }, [article, apiKey, saveVersion]);

  // ── Pressnote / WhatsApp → News ──
  const processPressnote = useCallback(async () => {
    if (!pressnote.trim()) return;
    setPressnoteLoading(true); setApiError(null); setPressnoteResult(null);
    setPressnoteProgress(0);
    const timer = setInterval(() => setPressnoteProgress(p => Math.min(p + 8, 88)), 400);
    try {
      const parsed = await callGemini(apiKey, PRESSNOTE_PROMPT, `Process this press note / message:\n\n${pressnote}`);
      setPressnoteResult(parsed);
      setPressnoteProgress(100);
    } catch (e) { setApiError(`Pressnote Error: ${e.message}`); }
    finally { setPressnoteLoading(false); clearInterval(timer); }
  }, [pressnote, apiKey]);

  const handleKeyDown = useCallback(e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") analyse();
  }, [analyse]);

  const handleFileInput = e => { const f = e.target.files[0]; if (f) processMedia(f); };
  const handleDrop = useCallback(e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) processMedia(f);
  }, [processMedia]);

  const words      = countWords(article);
  const overLimit  = storyLimit && parseInt(storyLimit) > 0 && words > parseInt(storyLimit);
  const hasErrors  = segments.some(s => s.type === "error");
  const errCount   = segments.filter(s => s.type === "error").length;
  const consistencyErrs = (analysis?.errors||[]).filter(e => e.type === "consistency");
  const displayPairs  = customPairs || analysis?.pairs || [];
  const limitedText   = storyLimit && parseInt(storyLimit) > 0 ? truncateWords(article, parseInt(storyLimit)) : article;
  const limitedSegs   = storyLimit && parseInt(storyLimit) > 0 ? buildSegments(limitedText, analysis?.errors||[]) : segments;
  const displayRw     = rwResult ? (rwDispLimit && parseInt(rwDispLimit) > 0 ? truncateWords(rwResult, parseInt(rwDispLimit)) : rwResult) : "";

  if (!apiKey) return <ApiKeyGate onSave={saveKey} />;

  const Spinner = ({ size=13 }) => <div style={{ width:size, height:size, border:`2px solid rgba(255,255,255,.2)`, borderTopColor:"#fff", borderRadius:"50%", animation:"spin .7s linear infinite", flexShrink:0 }} />;

  return (
    <div style={{ minHeight:"100vh", background:"#0D1117", color:"#E6EDF3", fontFamily:"'Inter',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+Devanagari:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#161B22}::-webkit-scrollbar-thumb{background:#30363D;border-radius:3px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .tab{background:none;border:none;cursor:pointer;padding:10px 18px;font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;transition:all .2s;border-bottom:2px solid transparent;color:#6E7681;white-space:nowrap}
        .tab.on{color:#E6EDF3;border-bottom-color:#C8102E;background:#1C2128}
        .tab:hover:not(.on){color:#C9D1D9;background:#161B22}
        .btn-r{background:linear-gradient(135deg,#C8102E,#E53E3E);color:#fff;border:none;padding:9px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
        .btn-r:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 4px 14px rgba(200,16,46,.4)}
        .btn-r:disabled{opacity:.38;cursor:not-allowed}
        .btn-b{background:linear-gradient(135deg,#1F6FEB,#388BFD);color:#fff;border:none;padding:9px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
        .btn-b:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px)}
        .btn-b:disabled{opacity:.38;cursor:not-allowed}
        .btn-g{background:transparent;color:#8B949E;border:1px solid #30363D;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .18s;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
        .btn-g:hover:not(:disabled){background:#21262D;border-color:#58A6FF;color:#58A6FF}
        .btn-g:disabled{opacity:.35;cursor:not-allowed}
        .inp{background:#161B22;border:1.5px solid #30363D;border-radius:8px;color:#E6EDF3;font-size:16px;line-height:2.1;padding:14px 16px;font-family:'Noto Serif Devanagari',serif;resize:vertical;outline:none;transition:border-color .2s;width:100%}
        .inp:focus{border-color:#C8102E;box-shadow:0 0 0 3px rgba(200,16,46,.08)}
        .inp::placeholder{color:#3D444D}
        .tinp{background:#161B22;border:1px solid #30363D;border-radius:6px;color:#E6EDF3;font-size:13px;line-height:1.6;padding:9px 13px;font-family:'Inter',sans-serif;resize:none;outline:none;transition:border-color .2s;width:100%}
        .tinp:focus{border-color:#388BFD}.tinp::placeholder{color:#3D444D}
        .ninp{background:#161B22;border:1px solid #30363D;border-radius:6px;color:#E6EDF3;font-size:12px;padding:7px 10px;outline:none;font-family:'Inter',sans-serif;width:80px;-moz-appearance:textfield;transition:border-color .2s}
        .ninp:focus{border-color:#388BFD}.ninp::-webkit-inner-spin-button,.ninp::-webkit-outer-spin-button{-webkit-appearance:none}
        .card{background:#161B22;border:1px solid #21262D;border-radius:10px}
        .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#6E7681}
        .err-w{color:#FF6B6B;background:rgba(255,107,107,.12);border-bottom:2px solid #FF4444;border-radius:3px 3px 0 0;padding:0 2px;cursor:help;font-weight:600}
        .err-c{color:#FBBF24;background:rgba(251,191,36,.1);border-bottom:2px solid #F59E0B;border-radius:3px 3px 0 0;padding:0 2px;cursor:help;font-weight:600}
        .err-b{color:#484F58;font-size:.9em}
        .err-f{color:#4ADE80;background:rgba(74,222,128,.1);border-bottom:2px solid #22C55E;border-radius:3px 3px 0 0;padding:0 2px;font-weight:700}
        .drop-z{border:2px dashed #30363D;border-radius:8px;padding:14px;text-align:center;cursor:pointer;transition:all .2s;background:#0D1117}
        .drop-z:hover,.drop-z.over{border-color:#C8102E;background:rgba(200,16,46,.04)}
        .rw-slide{background:#0D1117;border:1px solid #21262D;border-top:none;border-radius:0 0 10px 10px;animation:rwSlide .25s ease;overflow:hidden}
        @keyframes rwSlide{from{opacity:0;max-height:0}to{opacity:1;max-height:1000px}}
        .tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
      `}</style>

      {/* ── NAV ── */}
      <div style={{ background:"#161B22", borderBottom:"1px solid #21262D", padding:"0 24px", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ maxWidth:940, margin:"0 auto", height:52, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:30, height:30, background:"linear-gradient(135deg,#C8102E,#8B0000)", borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>📰</div>
            <div>
              <div style={{ fontWeight:800, fontSize:13, color:"#E6EDF3", letterSpacing:-.2 }}>Dainik Bhaskar NewsDesk</div>
              <div style={{ fontSize:9, color:"#484F58", letterSpacing:.8, textTransform:"uppercase" }}>AI Reporter · Editor Suite · Gemini Powered</div>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {analysis?.story_category && (
              <span className="tag" style={{ background:(CAT_COLORS[analysis.story_category]||"#30363D")+"22", color:CAT_COLORS[analysis.story_category]||"#8B949E", border:`1px solid ${(CAT_COLORS[analysis.story_category]||"#30363D")}44` }}>
                {analysis.story_category.toUpperCase()}
              </span>
            )}
            <div style={{ display:"flex", alignItems:"center", gap:4, background:"#0D1117", border:`1px solid ${overLimit?"#7D2A2A":"#21262D"}`, borderRadius:20, padding:"3px 10px", fontSize:12 }}>
              <span style={{ fontWeight:700, color:overLimit?"#F87171":"#E6EDF3" }}>{words}</span>
              <span style={{ color:"#484F58" }}>w</span>
              {storyLimit&&<><span style={{ color:"#30363D" }}>/</span><span style={{ color:"#484F58" }}>{storyLimit}</span></>}
              {overLimit&&<span style={{ color:"#F87171", fontWeight:700, fontSize:10 }}>+{words-parseInt(storyLimit)}</span>}
            </div>
            {versions.length > 0 && (
              <button className="btn-g" style={{ padding:"4px 9px", fontSize:11 }} onClick={()=>setShowVersions(v=>!v)}>🕒 {versions.length}</button>
            )}
            <button className="btn-g" style={{ padding:"4px 9px", fontSize:11 }} onClick={clearAll}>Clear</button>
            <button className="btn-g" style={{ padding:"4px 9px", fontSize:11 }} onClick={logout}>🔑 Logout</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:940, margin:"0 auto", padding:"18px 24px" }}>

        {/* ── VERSION HISTORY ── */}
        {showVersions && versions.length > 0 && (
          <div className="card" style={{ marginBottom:14, overflow:"hidden", animation:"fadeIn .2s ease" }}>
            <div style={{ padding:"9px 14px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span className="lbl">Version History</span>
              <button className="btn-g" style={{ padding:"3px 8px", fontSize:10 }} onClick={()=>setShowVersions(false)}>✕</button>
            </div>
            {[...versions].reverse().map((v,i)=>(
              <div key={i} style={{ padding:"8px 14px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ display:"flex", gap:10, fontSize:12 }}>
                  <span style={{ color:"#484F58" }}>🕒 {v.time}</span>
                  <span style={{ color:"#8B949E" }}>{v.label}</span>
                  <span style={{ color:"#484F58" }}>— {countWords(v.text)} words</span>
                </div>
                <button className="btn-g" style={{ padding:"2px 9px", fontSize:10 }} onClick={()=>{setArticle(v.text); setShowVersions(false);}}>Restore</button>
              </div>
            ))}
          </div>
        )}

        {/* ── EDITOR CARD ── */}
        <div className="card" style={{ marginBottom: rwOpen ? 0 : 14, borderRadius: rwOpen?"10px 10px 0 0":10 }}>
          <div style={{ padding:"16px 18px 12px" }}>
            {/* Top bar */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:8 }}>
              <span className="lbl">Story Editor</span>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <span className="lbl" style={{ color:"#484F58" }}>Word Limit</span>
                <input type="number" className="ninp" placeholder="e.g. 300" value={storyLimit} onChange={e=>setStoryLimit(e.target.value)} min="0" />
                {/* Upload button inline */}
                <input ref={fileRef} type="file" style={{ display:"none" }} accept="image/*,.pdf,.txt,.doc,.docx" onChange={handleFileInput} />
                <button className="btn-g" style={{ fontSize:11, padding:"5px 10px" }}
                  onClick={()=>fileRef.current.click()} disabled={mediaLoading}
                  onDragOver={e=>{e.preventDefault();e.currentTarget.classList.add("over")}}
                  onDragLeave={e=>e.currentTarget.classList.remove("over")}
                  onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove("over");const f=e.dataTransfer.files[0];if(f)processMedia(f);}}>
                  {mediaLoading ? <><Spinner />Reading…</> : "📎 Upload"}
                </button>
                <button className="btn-g" style={{ fontSize:11, padding:"5px 10px" }} onClick={translateToHindi} disabled={transLoading||!article.trim()}>
                  {transLoading ? <><Spinner />Translating…</> : "🌐 → Hindi"}
                </button>
                <button className="btn-g" style={{ fontSize:11, padding:"5px 10px", borderColor:rwOpen?"#C8102E":"#30363D", color:rwOpen?"#C8102E":"#8B949E" }} onClick={()=>setRwOpen(o=>!o)}>
                  {rwOpen?"✕ Rewrite":"✍ Rewrite"}
                </button>
              </div>
            </div>

            <textarea ref={editorRef} className="inp" style={{ minHeight:190 }} value={article} onChange={e=>setArticle(e.target.value)} onKeyDown={handleKeyDown} placeholder="यहाँ अपना समाचार लिखें... (Hindi or English)" spellCheck={false} />

            {/* Media upload drop hint */}
            {uploadedFile && !mediaLoading && (
              <div style={{ marginTop:8, fontSize:11, color:"#484F58", display:"flex", alignItems:"center", gap:6 }}>
                <span>📎</span><span>{uploadedFile.name}</span>
                {mediaResult && <button className="btn-g" style={{ fontSize:10, padding:"2px 8px" }} onClick={()=>{setArticle(mediaResult.article||"");setMediaResult(null);setUploadedFile(null);}}>Use in Editor</button>}
              </div>
            )}

            {apiError && (
              <div style={{ marginTop:8, background:"#2D1117", border:"1px solid #7D2A2A", borderRadius:6, padding:"8px 12px", color:"#F87171", fontSize:12, lineHeight:1.5 }}>⚠ {apiError}</div>
            )}

            {/* Progress bar */}
            {loading && <ProgressBar progress={progress} label={progressLabel} />}

            <div style={{ marginTop:10, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
              <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                <span style={{ fontSize:11, color:"#484F58" }}>Ctrl+Enter to analyse</span>
                {analysis?.seo_keywords?.slice(0,3).map((k,i)=>(
                  <span key={i} className="tag" style={{ background:"#21262D", color:"#8B949E", fontSize:10 }}>{k}</span>
                ))}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-g" style={{ fontSize:11 }} onClick={()=>saveVersion(article,"Manual save")} disabled={!article.trim()}>💾 Save</button>
                <button className="btn-r" onClick={analyse} disabled={loading||!article.trim()}>
                  {loading ? <><Spinner />Analysing…</> : <>⚡ Analyse Story</>}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── REWRITE PANEL ── */}
        {rwOpen && (
          <div className="rw-slide" style={{ marginBottom:14 }}>
            <div style={{ padding:"14px 18px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10, flexWrap:"wrap" }}>
                <span className="lbl" style={{ color:"#C8102E" }}>Rewrite in DB Style</span>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:11, color:"#6E7681" }}>Max words</span>
                  <input type="number" className="ninp" placeholder="e.g. 300" value={rwLimit} onChange={e=>setRwLimit(e.target.value)} min="0" />
                </div>
              </div>
              <textarea className="tinp" value={rwPrompt} onChange={e=>setRwPrompt(e.target.value)} placeholder="Instructions e.g. front-page style, add emotional angle, shorten for online…" rows={2} />
              <div style={{ marginTop:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:11, color:"#484F58" }}>Rewrites using Dainik Bhaskar editorial guidelines</span>
                <button className="btn-b" onClick={rewrite} disabled={rwLoading||!article.trim()}>
                  {rwLoading?<><Spinner/>Rewriting…</>:<>✍ Rewrite Story</>}
                </button>
              </div>
            </div>
            {rwResult && (
              <div style={{ borderTop:"1px solid #21262D" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 18px", background:"#161B22", flexWrap:"wrap", gap:8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:12, fontWeight:700, color:"#4ADE80", textTransform:"uppercase" }}>Rewritten</span>
                    <span style={{ fontSize:12, color:"#484F58" }}>{countWords(rwResult)} words</span>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:11, color:"#6E7681" }}>Display limit</span>
                    <input type="number" className="ninp" placeholder="words" value={rwDispLimit} onChange={e=>setRwDispLimit(e.target.value)} min="0" />
                    <button className="btn-g" style={{ fontSize:11, padding:"4px 9px" }} onClick={()=>navigator.clipboard.writeText(rwResult)}>Copy</button>
                    <button className="btn-g" style={{ fontSize:11, padding:"4px 9px" }} onClick={()=>{saveVersion(article,"Before use rewrite");setArticle(rwResult);setRwResult(null);setRwOpen(false);}}>Use ↑</button>
                  </div>
                </div>
                <div style={{ padding:"16px 18px", fontSize:16, lineHeight:2.1, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>{displayRw}</div>
              </div>
            )}
          </div>
        )}

        {/* ── PRESSNOTE / WHATSAPP TAB INPUT ── */}
        <div className="card" style={{ marginBottom:14 }}>
          <div style={{ padding:"12px 18px 10px", borderBottom:"1px solid #21262D", display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:16 }}>📋</span>
            <div>
              <div className="lbl" style={{ color:"#C8102E" }}>Press Note / WhatsApp Paste</div>
              <div style={{ fontSize:11, color:"#484F58" }}>Paste forwarded press note or WhatsApp message (Hindi or English) → get DB-style news</div>
            </div>
          </div>
          <div style={{ padding:"12px 18px" }}>
            <textarea className="tinp" style={{ minHeight:90, fontFamily:"'Noto Serif Devanagari',serif", fontSize:15 }} value={pressnote} onChange={e=>setPressnote(e.target.value)} placeholder="यहाँ प्रेस नोट या WhatsApp फॉरवर्ड पेस्ट करें… (Hindi / English)" />
            {pressnoteLoading && (
              <div style={{ marginTop:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:12, color:"#8B949E" }}>Generating DB-style news…</span>
                  <span style={{ fontSize:12, color:"#C8102E", fontWeight:700 }}>{pressnoteProgress}%</span>
                </div>
                <div style={{ height:4, background:"#21262D", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${pressnoteProgress}%`, background:"linear-gradient(90deg,#C8102E,#E53E3E)", transition:"width .3s ease", borderRadius:2 }} />
                </div>
              </div>
            )}
            <div style={{ marginTop:10, display:"flex", justifyContent:"flex-end" }}>
              <button className="btn-r" onClick={processPressnote} disabled={pressnoteLoading||!pressnote.trim()}>
                {pressnoteLoading?<><Spinner/>Processing…</>:<>📰 Generate News</>}
              </button>
            </div>
          </div>
        </div>

        {/* Pressnote result */}
        {pressnoteResult && !pressnoteLoading && (
          <div className="card" style={{ marginBottom:14, overflow:"hidden", animation:"fadeIn .3s ease", borderTop:"2px solid #C8102E" }}>
            <div style={{ padding:"10px 18px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#161B22", flexWrap:"wrap", gap:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:12, fontWeight:700, color:"#C8102E", textTransform:"uppercase" }}>📋 Press Note → News</span>
                {pressnoteResult.detected_language && <span className="tag" style={{ background:"#21262D", color:"#8B949E" }}>Source: {pressnoteResult.detected_language}</span>}
                {pressnoteResult.source_type && <span className="tag" style={{ background:"#21262D", color:"#8B949E" }}>{pressnoteResult.source_type.replace("_"," ")}</span>}
                <span style={{ fontSize:11, color:"#484F58" }}>{countWords(pressnoteResult.article||"")} words</span>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-g" style={{ fontSize:11, padding:"4px 9px" }} onClick={()=>navigator.clipboard.writeText(pressnoteResult.article||"")}>Copy</button>
                <button className="btn-g" style={{ fontSize:11, padding:"4px 9px" }} onClick={()=>{setArticle(pressnoteResult.article||"");setPressnoteResult(null);}}>Use in Editor ↑</button>
              </div>
            </div>

            {/* Side-by-side comparison */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:0 }}>
              <div style={{ padding:"16px 18px", borderRight:"1px solid #21262D" }}>
                <div className="lbl" style={{ marginBottom:10, color:"#F87171" }}>Original / Source</div>
                <div style={{ fontSize:14, lineHeight:1.85, color:"#8B949E", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap", maxHeight:320, overflowY:"auto" }}>{pressnote}</div>
              </div>
              <div style={{ padding:"16px 18px" }}>
                <div className="lbl" style={{ marginBottom:10, color:"#4ADE80" }}>DB-Style Rewrite</div>
                <div style={{ fontSize:15, lineHeight:2.0, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap", maxHeight:320, overflowY:"auto" }}>{pressnoteResult.article}</div>
              </div>
            </div>

            {/* Key facts & verify */}
            {(pressnoteResult.key_facts?.length > 0 || pressnoteResult.verify_needed?.length > 0) && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", borderTop:"1px solid #21262D" }}>
                {pressnoteResult.key_facts?.length > 0 && (
                  <div style={{ padding:"12px 18px", borderRight:"1px solid #21262D" }}>
                    <div className="lbl" style={{ marginBottom:8, color:"#4ADE80" }}>Key Facts Extracted</div>
                    {pressnoteResult.key_facts.map((f,i)=>(
                      <div key={i} style={{ fontSize:12, color:"#8B949E", marginBottom:5, paddingLeft:10, borderLeft:"2px solid #238636" }}>• {f}</div>
                    ))}
                  </div>
                )}
                {pressnoteResult.verify_needed?.length > 0 && (
                  <div style={{ padding:"12px 18px" }}>
                    <div className="lbl" style={{ marginBottom:8, color:"#FBBF24" }}>Needs Verification</div>
                    {pressnoteResult.verify_needed.map((f,i)=>(
                      <div key={i} style={{ fontSize:12, color:"#8B949E", marginBottom:5, paddingLeft:10, borderLeft:"2px solid #9A6700" }}>⚠ {f}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Quick headlines from pressnote */}
            {pressnoteResult.pairs?.length > 0 && (
              <div style={{ padding:"12px 18px", borderTop:"1px solid #21262D" }}>
                <div className="lbl" style={{ marginBottom:10 }}>Quick Headlines</div>
                {pressnoteResult.pairs.map((p,i)=>(
                  <div key={i} style={{ padding:"10px 12px", background:"#0D1117", border:"1px solid #21262D", borderRadius:6, marginBottom:8 }}>
                    <div style={{ fontSize:15, fontWeight:700, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", marginBottom:5 }}>{p.headline}</div>
                    <div style={{ fontSize:13, color:"#8B949E", fontFamily:"'Noto Serif Devanagari',serif" }}>{p.subheadline}</div>
                  </div>
                ))}
              </div>
            )}

            {/* WhatsApp integration info */}
            <div style={{ padding:"10px 18px", borderTop:"1px solid #21262D", background:"#0D1117" }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:11, color:"#484F58", lineHeight:1.6 }}>
                <span style={{ color:"#25D366", fontSize:14 }}>💬</span>
                <span><span style={{ color:"#8B949E", fontWeight:600 }}>WhatsApp Integration:</span> To auto-receive messages here, set up a WhatsApp Business API webhook (Twilio / Meta Cloud API) that POSTs incoming messages to your backend. Your backend can then call this tool's API. <span style={{ color:"#388BFD" }}>Ask your tech team to configure the webhook URL.</span></span>
              </div>
            </div>
          </div>
        )}

        {/* Media result */}
        {mediaResult && !mediaLoading && (
          <div className="card" style={{ marginBottom:14, overflow:"hidden", animation:"fadeIn .3s ease", borderTop:"2px solid #3B82F6" }}>
            <div style={{ padding:"10px 18px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#161B22", flexWrap:"wrap", gap:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:12, fontWeight:700, color:"#3B82F6", textTransform:"uppercase" }}>📎 File → News</span>
                {mediaResult.detected_language && <span className="tag" style={{ background:"#21262D", color:"#8B949E" }}>{mediaResult.detected_language}</span>}
                <span style={{ fontSize:11, color:"#484F58" }}>{countWords(mediaResult.article||"")} words</span>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-g" style={{ fontSize:11, padding:"4px 9px" }} onClick={()=>navigator.clipboard.writeText(mediaResult.article||"")}>Copy</button>
                <button className="btn-g" style={{ fontSize:11, padding:"4px 9px" }} onClick={()=>{setArticle(mediaResult.article||"");setMediaResult(null);setUploadedFile(null);}}>Use in Editor ↑</button>
              </div>
            </div>
            <div style={{ padding:"16px 18px", fontSize:16, lineHeight:2.1, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>{mediaResult.article}</div>
            {mediaResult.pairs?.length > 0 && (
              <div style={{ padding:"0 18px 14px" }}>
                <div style={{ height:1, background:"#21262D", margin:"0 0 12px" }} />
                <div className="lbl" style={{ marginBottom:10 }}>Quick Headlines</div>
                {mediaResult.pairs.map((p,i)=>(
                  <div key={i} style={{ padding:"10px 12px", background:"#0D1117", border:"1px solid #21262D", borderRadius:6, marginBottom:7 }}>
                    <div style={{ fontSize:15, fontWeight:700, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", marginBottom:4 }}>{p.headline}</div>
                    <div style={{ fontSize:13, color:"#8B949E", fontFamily:"'Noto Serif Devanagari',serif" }}>{p.subheadline}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── RESULTS TABS ── */}
        {analysis && !loading && (
          <div className="card" style={{ overflow:"hidden", animation:"fadeIn .3s ease" }}>
            <div style={{ display:"flex", borderBottom:"1px solid #21262D", background:"#0D1117", overflowX:"auto" }}>
              {[
                { k:"grammar", label:"Grammar Check", badge: errCount>0?errCount:null, bc:"#CF222E" },
                { k:"consistency", label:"Consistency Check", badge: consistencyErrs.length>0?consistencyErrs.length:null, bc:"#F59E0B" },
                { k:"headlines", label:"Headlines & Subheads", badge:displayPairs.length||null, bc:"#C8102E" },
                ...(analysis.missing_elements?.length>0?[{ k:"missing", label:"Missing Elements", badge:analysis.missing_elements.length, bc:"#EF4444" }]:[]),
              ].map(t=>(
                <button key={t.k} className={`tab ${activeTab===t.k?"on":""}`} onClick={()=>setActiveTab(t.k)}>
                  {t.label}
                  {t.badge!=null&&<span style={{ background:activeTab===t.k?t.bc:"#21262D", color:activeTab===t.k?"#fff":"#6E7681", borderRadius:20, padding:"1px 6px", fontSize:10, marginLeft:5, fontWeight:700 }}>{t.badge}</span>}
                </button>
              ))}
            </div>

            <div style={{ padding:"20px 22px" }}>

              {/* GRAMMAR */}
              {activeTab==="grammar" && (
                <div style={{ animation:"fadeIn .25s ease" }}>
                  {analysis.summary && (
                    <div style={{ background:"#0D1117", border:"1px solid #21262D", borderLeft:"3px solid #C8102E", borderRadius:"0 8px 8px 0", padding:"12px 16px", marginBottom:16 }}>
                      <div className="lbl" style={{ color:"#C8102E", marginBottom:6 }}>Editorial Feedback</div>
                      <p style={{ fontSize:15, lineHeight:1.9, color:"#C9D1D9", fontFamily:"'Noto Serif Devanagari',serif" }}>{analysis.summary}</p>
                    </div>
                  )}
                  {storyLimit&&parseInt(storyLimit)>0&&(
                    <div style={{ marginBottom:14, background:"#161B22", border:"1px solid #21262D", borderRadius:6, padding:"7px 14px", display:"flex", alignItems:"center", gap:8, fontSize:12 }}>
                      <span style={{ color:"#6E7681" }}>Word limit active:</span>
                      <span style={{ color:"#58A6FF", fontWeight:700 }}>{storyLimit} words</span>
                      {overLimit&&<span style={{ color:"#F87171", fontWeight:600, marginLeft:"auto" }}>⚠ {words-parseInt(storyLimit)} over</span>}
                    </div>
                  )}
                  {hasErrors && (
                    <div style={{ display:"flex", gap:12, marginBottom:12, alignItems:"center", flexWrap:"wrap" }}>
                      <span className="lbl">Legend:</span>
                      <span style={{ fontSize:13, fontFamily:"'Noto Serif Devanagari',serif" }}>
                        <span className="err-w" style={{ cursor:"default" }}>गलत</span><span className="err-b"> [</span><span className="err-f">सही</span><span className="err-b">]</span>
                      </span>
                      <span style={{ fontSize:11, color:"#484F58" }}>Hover for reason</span>
                    </div>
                  )}
                  {!hasErrors ? (
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:10 }}>
                        <span style={{ color:"#4ADE80" }}>✓</span>
                        <span style={{ fontSize:13, color:"#4ADE80", fontWeight:600 }}>No grammar errors</span>
                      </div>
                      <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"16px 18px", fontSize:16, lineHeight:2.2, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>{limitedText}</div>
                    </div>
                  ) : (
                    <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"16px 18px", fontSize:16, lineHeight:2.4, fontFamily:"'Noto Serif Devanagari',serif", color:"#E6EDF3", whiteSpace:"pre-wrap" }}>
                      {limitedSegs.map((seg,i)=>{
                        if(seg.type==="normal") return <span key={i}>{seg.text}</span>;
                        const isConsistency = seg.type==="consistency";
                        return (
                          <span key={i} title={seg.explanation||""} style={{ cursor:"help" }}>
                            <span className={isConsistency?"err-c":"err-w"}>{seg.original}</span>
                            <span className="err-b"> [</span><span className="err-f">{seg.correction}</span><span className="err-b">] </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* CONSISTENCY */}
              {activeTab==="consistency" && (
                <div style={{ animation:"fadeIn .25s ease" }}>
                  <div style={{ marginBottom:14, fontSize:13, color:"#8B949E", lineHeight:1.6 }}>
                    These are factual inconsistencies between your <span style={{ color:"#FBBF24" }}>headline/subheadline</span> and the <span style={{ color:"#E6EDF3" }}>story body</span> — numbers, names, dates that don't match.
                  </div>
                  {consistencyErrs.length === 0 ? (
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ color:"#4ADE80", fontSize:16 }}>✓</span>
                      <span style={{ fontSize:13, color:"#4ADE80", fontWeight:600 }}>No consistency issues found. Headlines match the story.</span>
                    </div>
                  ) : consistencyErrs.map((e,i)=>(
                    <div key={i} style={{ padding:"12px 14px", background:"#0D1117", border:"1px solid #9A6700", borderLeft:"4px solid #FBBF24", borderRadius:"0 8px 8px 0", marginBottom:10, animation:"fadeIn .3s ease" }}>
                      <div style={{ display:"flex", gap:8, alignItems:"flex-start", marginBottom:8 }}>
                        <span style={{ color:"#FBBF24", fontSize:16, marginTop:1 }}>⚠</span>
                        <div>
                          <div style={{ fontSize:13, color:"#FBBF24", fontWeight:700, marginBottom:4 }}>Consistency Error #{i+1}</div>
                          <div style={{ fontSize:14, color:"#C9D1D9", fontFamily:"'Noto Serif Devanagari',serif", lineHeight:1.7 }}>{e.explanation}</div>
                        </div>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap:8, alignItems:"center" }}>
                        <div style={{ background:"#2D1A00", border:"1px solid #9A6700", borderRadius:6, padding:"8px 12px", fontSize:15, color:"#FBBF24", fontFamily:"'Noto Serif Devanagari',serif", fontWeight:600 }}>{e.original}</div>
                        <span style={{ color:"#484F58", fontSize:18 }}>→</span>
                        <div style={{ background:"#003D00", border:"1px solid #238636", borderRadius:6, padding:"8px 12px", fontSize:15, color:"#4ADE80", fontFamily:"'Noto Serif Devanagari',serif", fontWeight:600 }}>{e.correction}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* HEADLINES */}
              {activeTab==="headlines" && (
                <div style={{ animation:"fadeIn .25s ease" }}>
                  <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"14px 16px", marginBottom:16 }}>
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
                    <textarea className="tinp" value={hlPrompt} onChange={e=>setHlPrompt(e.target.value)} placeholder="Custom instruction e.g. dramatic tone, political angle, Madhya Pradesh audience…" rows={2} />
                    <div style={{ marginTop:10, display:"flex", justifyContent:"flex-end" }}>
                      <button className="btn-r" onClick={genHeadlines} disabled={hlLoading||!article.trim()}>
                        {hlLoading?<><Spinner/>Generating…</>:<>⚡ Regenerate Pairs</>}
                      </button>
                    </div>
                  </div>
                  {customPairs&&<div style={{ background:"#1C2128", border:"1px solid #C8102E33", borderRadius:6, padding:"6px 12px", marginBottom:12, fontSize:12, color:"#C8102E" }}>✦ Custom pairs</div>}
                  <div className="lbl" style={{ marginBottom:10 }}>Headline + Sub-Headline Pairs ({displayPairs.length})</div>
                  {displayPairs.map((p,i)=><PairCard key={i} p={p} i={i} hlHeadLimit={hlHeadLimit} hlSubLimit={hlSubLimit} />)}
                </div>
              )}

              {/* MISSING */}
              {activeTab==="missing" && (
                <div style={{ animation:"fadeIn .25s ease" }}>
                  <div style={{ marginBottom:12, fontSize:13, color:"#8B949E" }}>Important journalistic elements missing or weak in your story:</div>
                  {analysis.missing_elements?.map((m,i)=>(
                    <div key={i} style={{ display:"flex", gap:8, padding:"10px 12px", background:"#0D1117", border:"1px solid #21262D", borderLeft:"3px solid #F87171", borderRadius:"0 6px 6px 0", marginBottom:8 }}>
                      <span style={{ color:"#F87171", fontWeight:700 }}>⚠</span>
                      <span style={{ fontSize:14, color:"#C9D1D9", fontFamily:"'Noto Serif Devanagari',serif", lineHeight:1.7 }}>{m}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!analysis && !loading && !mediaResult && !pressnoteResult && (
          <div style={{ textAlign:"center", padding:"36px 0" }}>
            <div style={{ fontSize:36, opacity:.1, marginBottom:10 }}>📰</div>
            <div style={{ fontSize:14, color:"#484F58", fontWeight:500 }}>Write your story or paste a press note to get started</div>
            <div style={{ fontSize:12, color:"#30363D", marginTop:5 }}>Grammar · Consistency Check · 20 Headlines · DB Rewrite · File Upload · Translate</div>
          </div>
        )}
      </div>

      <div style={{ borderTop:"1px solid #21262D", padding:"10px 24px", textAlign:"center" }}>
        <div style={{ fontSize:10, color:"#30363D", letterSpacing:.8, textTransform:"uppercase" }}>Dainik Bhaskar NewsDesk · Gemini AI · Professional Reporter Suite</div>
      </div>
    </div>
  );
}