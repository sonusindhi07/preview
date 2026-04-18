import { useState, useRef, useCallback } from "react";

// ─── DB EDITORIAL STYLE (shared across all prompts) ─────────────────────────
const DB_STYLE = `
DAINIK BHASKAR EDITORIAL STYLE (MANDATORY):
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
- अा vs आ, ाे/ाै vs ो/ौ, िव vs वि, मंे vs में — same word, different encoding. IGNORE.
- Only flag genuine grammar or wrong-letter spelling mistakes. When in doubt, do NOT flag.

Respond ONLY with a valid JSON object. No markdown, no backticks.
{
  "errors": [ { "original": "exact substring", "correction": "corrected", "explanation": "short reason" } ],
  "pairs": [ { "headline": "Hindi headline", "subheadline": "matching sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "angle": "one word", "score": 90 } ],
  "summary": "2-3 sentence editorial feedback in Hindi",
  "seo_keywords": ["keyword1","keyword2","keyword3"],
  "story_category": "politics|crime|sports|health|business|local|national|international|entertainment",
  "missing_elements": ["element if any important journalistic element is missing"]
}
Rules: EXACTLY 20 pairs. Score 1-100. Escape double-quotes as \\". No trailing commas.`;

const HEADLINES_PROMPT = `You are a senior Dainik Bhaskar headline writer.
Generate exactly 20 headline+subheadline pairs. Enforce word limits if given.
Respond ONLY with valid JSON:
{ "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "angle": "one word", "score": 90 } ] }
Score 1-100. Escape double-quotes as \\".`;

const REWRITE_PROMPT = `You are a senior state editor at Dainik Bhaskar.
${DB_STYLE}
If word count is specified, stay within that limit strictly.
Respond ONLY with valid JSON: { "rewritten": "full DB-style Hindi article" }
Escape double-quotes as \\".`;

const MEDIA_TO_NEWS_PROMPT = `You are a senior reporter at Dainik Bhaskar newspaper.
${DB_STYLE}

You will receive content from a press note, image, document, or other media (possibly in English).
Your task:
1. Extract all factual information from the content.
2. Write a complete, professional news article in Hindi following Dainik Bhaskar style.
3. If content is in English, translate and rewrite in Hindi.
4. Generate 5 headline+subheadline pairs.

Respond ONLY with valid JSON:
{
  "article": "complete Hindi news article in DB style",
  "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "score": 90 } ],
  "summary": "brief note about the source content in English",
  "detected_language": "Hindi|English|Mixed|Other"
}
Escape double-quotes as \\". No trailing commas.`;

const TRANSLATE_PROMPT = `You are a professional Hindi translator and journalist at Dainik Bhaskar.
Translate the given text to Hindi, then rewrite it as a proper DB-style news article.
${DB_STYLE}
Respond ONLY with valid JSON: { "translated": "Hindi translation", "article": "DB-style Hindi news article" }
Escape double-quotes as \\".`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildSegments(text, errors) {
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
}

function extractJSON(raw) {
  let s = raw.replace(/```json|```/gi, "").trim();
  try { return JSON.parse(s); } catch (_) {}
  const st = s.indexOf("{"), en = s.lastIndexOf("}");
  if (st !== -1 && en !== -1) { try { return JSON.parse(s.slice(st, en + 1)); } catch (_) {} }
  return null;
}

async function callAPI(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system, messages }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
  const data = await res.json();
  const raw = data.content?.map(i => i.text || "").join("") || "";
  const parsed = extractJSON(raw);
  if (!parsed) throw new Error("Could not parse response. Please retry.");
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
  breaking: "#EF4444", informative: "#3B82F6", dramatic: "#8B5CF6",
  soft: "#10B981", question: "#F59E0B", statistic: "#06B6D4"
};

const CAT_COLORS = {
  politics:"#EF4444", crime:"#F97316", sports:"#10B981", health:"#06B6D4",
  business:"#3B82F6", local:"#8B5CF6", national:"#F59E0B", international:"#EC4899", entertainment:"#14B8A6"
};

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function App() {
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

  // Rewrite panel (inline below editor)
  const [rwOpen, setRwOpen]     = useState(false);
  const [rwPrompt, setRwPrompt] = useState("");
  const [rwLimit, setRwLimit]   = useState("");
  const [rwLoading, setRwLoading] = useState(false);
  const [rwResult, setRwResult] = useState(null);
  const [rwDispLimit, setRwDispLimit] = useState("");

  // Media upload
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaResult, setMediaResult]   = useState(null);
  const [dragOver, setDragOver]         = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);

  // Translation
  const [transLoading, setTransLoading] = useState(false);
  const [transResult, setTransResult]   = useState(null);

  // Version history
  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);

  const editorRef = useRef(null);
  const fileRef   = useRef(null);

  const saveVersion = useCallback((text, label) => {
    setVersions(v => [...v.slice(-9), { text, label, time: new Date().toLocaleTimeString("en-IN") }]);
  }, []);

  const clearAll = () => {
    setArticle(""); setAnalysis(null); setSegments([]);
    setCustomPairs(null); setRwResult(null); setMediaResult(null); setTransResult(null);
    setApiError(null); setStoryLimit(""); setHlPrompt(""); setHlHeadLimit(""); setHlSubLimit("");
    setRwPrompt(""); setRwLimit(""); setRwDispLimit(""); setUploadedFile(null);
    setRwOpen(false); setShowVersions(false);
  };

  // ── Analyse ──
  const analyse = useCallback(async () => {
    if (article.trim().length < 20) { setApiError("Please write at least 20 characters."); return; }
    setLoading(true); setLoadingMsg("Checking grammar…"); setApiError(null);
    setAnalysis(null); setSegments([]); setCustomPairs(null); setRwResult(null);
    try {
      setLoadingMsg("Generating headlines & analysis…");
      const parsed = await callAPI(ANALYSIS_PROMPT, [{ role: "user", content: `Analyse:\n\n${article}` }]);
      setAnalysis(parsed);
      setSegments(buildSegments(article, parsed.errors || []));
      setActiveTab("grammar");
    } catch (e) { setApiError(`Error: ${e.message}`); }
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
      const parsed = await callAPI(REWRITE_PROMPT, [{ role: "user", content: `Article:\n\n${article}\n\nInstruction: ${instr}` }]);
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
      let instr = hlPrompt.trim() || "Generate 20 best pairs.";
      if (hlHeadLimit) instr += ` Each headline max ${hlHeadLimit} words.`;
      if (hlSubLimit)  instr += ` Each sub-headline max ${hlSubLimit} words.`;
      const parsed = await callAPI(HEADLINES_PROMPT, [{ role: "user", content: `Article:\n\n${article}\n\nInstruction: ${instr}` }]);
      setCustomPairs(parsed.pairs || []);
    } catch (e) { setApiError(`Headlines Error: ${e.message}`); }
    finally { setHlLoading(false); }
  }, [article, hlPrompt, hlHeadLimit, hlSubLimit]);

  // ── Media to News ──
  const processMedia = useCallback(async (file) => {
    setMediaLoading(true); setApiError(null); setMediaResult(null);
    setUploadedFile(file);
    try {
      const isImage = file.type.startsWith("image/");
      const isPDF   = file.type === "application/pdf";
      const isText  = file.type.startsWith("text/") || file.name.endsWith(".txt");

      let messages;

      if (isImage) {
        const b64 = await toBase64(file);
        const mt = file.type;
        messages = [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
            { type: "text", text: "Read all text/content from this image and write a complete Dainik Bhaskar style Hindi news article from it." }
          ]
        }];
      } else if (isPDF) {
        const b64 = await toBase64(file);
        messages = [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: "Extract all content from this PDF and write a complete Dainik Bhaskar style Hindi news article." }
          ]
        }];
      } else if (isText) {
        const text = await file.text();
        messages = [{ role: "user", content: `Extract news from this content and write a Dainik Bhaskar Hindi news article:\n\n${text}` }];
      } else {
        // For video/audio/other — read as text if possible
        const text = await file.text().catch(() => `[File: ${file.name}, Type: ${file.type}]`);
        messages = [{ role: "user", content: `Extract news from this file content and write a Dainik Bhaskar Hindi news article:\n\nFilename: ${file.name}\n\nContent:\n${text}` }];
      }

      const parsed = await callAPI(MEDIA_TO_NEWS_PROMPT, messages);
      setMediaResult(parsed);
    } catch (e) { setApiError(`Media Error: ${e.message}`); }
    finally { setMediaLoading(false); }
  }, []);

  // ── Translate to Hindi ──
  const translateToHindi = useCallback(async () => {
    if (!article.trim()) { setApiError("Write text to translate."); return; }
    setTransLoading(true); setApiError(null); setTransResult(null);
    try {
      const parsed = await callAPI(TRANSLATE_PROMPT, [{ role: "user", content: `Translate and rewrite:\n\n${article}` }]);
      setTransResult(parsed);
    } catch (e) { setApiError(`Translation Error: ${e.message}`); }
    finally { setTransLoading(false); }
  }, [article]);

  // ── Drag & Drop ──
  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processMedia(file);
  }, [processMedia]);

  const handleFileInput = e => {
    const file = e.target.files[0];
    if (file) processMedia(file);
  };

  const handleKeyDown = useCallback(e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") analyse();
  }, [analyse]);

  const words     = countWords(article);
  const overLimit = storyLimit && parseInt(storyLimit) > 0 && words > parseInt(storyLimit);
  const hasErrors = segments.some(s => s.type === "error");
  const errCount  = segments.filter(s => s.type === "error").length;
  const displayPairs = customPairs || analysis?.pairs || [];
  const limitedText  = storyLimit && parseInt(storyLimit) > 0 ? truncateWords(article, parseInt(storyLimit)) : article;
  const limitedSegs  = storyLimit && parseInt(storyLimit) > 0 ? buildSegments(limitedText, analysis?.errors || []) : segments;
  const displayRw    = rwResult ? (rwDispLimit && parseInt(rwDispLimit) > 0 ? truncateWords(rwResult, parseInt(rwDispLimit)) : rwResult) : "";

  return (
    <div style={{ minHeight:"100vh", background:"#0D1117", color:"#E6EDF3", fontFamily:"'Inter',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+Devanagari:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#161B22}::-webkit-scrollbar-thumb{background:#30363D;border-radius:3px}

        .tab{background:none;border:none;cursor:pointer;padding:10px 18px;font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;transition:all .2s;border-bottom:2px solid transparent;color:#6E7681;white-space:nowrap}
        .tab.on{color:#E6EDF3;border-bottom-color:#C8102E;background:#1C2128}
        .tab:hover:not(.on){color:#C9D1D9;background:#161B22}

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

        .drop-zone{border:2px dashed #30363D;border-radius:10px;padding:28px 20px;text-align:center;transition:all .2s;cursor:pointer;background:#0D1117}
        .drop-zone.over{border-color:#C8102E;background:rgba(200,16,46,.06)}
        .drop-zone:hover{border-color:#484F58;background:#161B22}

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
      `}</style>

      {/* ── NAV ── */}
      <div style={{ background:"#161B22", borderBottom:"1px solid #21262D", padding:"0 28px", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ maxWidth:900, margin:"0 auto", height:54, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:32, height:32, background:"linear-gradient(135deg,#C8102E,#8B0000)", borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>📰</div>
            <div>
              <div style={{ fontWeight:800, fontSize:14, color:"#E6EDF3", letterSpacing:-.3 }}>Dainik Bhaskar NewsDesk</div>
              <div style={{ fontSize:10, color:"#484F58", letterSpacing:.8, textTransform:"uppercase" }}>AI Reporter · Editor Suite</div>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {analysis?.story_category && (
              <span className="tag" style={{ background: CAT_COLORS[analysis.story_category]+"33", color: CAT_COLORS[analysis.story_category], border:`1px solid ${CAT_COLORS[analysis.story_category]}44` }}>
                {analysis.story_category.toUpperCase()}
              </span>
            )}
            <div style={{ display:"flex", alignItems:"center", gap:5, background:"#0D1117", border:`1px solid ${overLimit?"#7D2A2A":"#21262D"}`, borderRadius:20, padding:"3px 12px", fontSize:12 }}>
              <span style={{ fontWeight:700, color: overLimit?"#F87171":"#E6EDF3" }}>{words}</span>
              <span style={{ color:"#484F58" }}>w</span>
              {storyLimit && <><span style={{ color:"#30363D" }}>/</span><span style={{ color:"#484F58" }}>{storyLimit}</span></>}
              {overLimit && <span style={{ color:"#F87171", fontWeight:700, fontSize:11 }}>+{words-parseInt(storyLimit)}</span>}
            </div>
            {versions.length > 0 && (
              <button className="btn-g" style={{ padding:"5px 10px", fontSize:11 }} onClick={()=>setShowVersions(v=>!v)}>
                🕒 {versions.length}
              </button>
            )}
            <button className="btn-g" style={{ padding:"5px 10px", fontSize:11 }} onClick={clearAll}>Clear</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:900, margin:"0 auto", padding:"20px 28px" }}>

        {/* ── VERSION HISTORY PANEL ── */}
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

        {/* ── MEDIA UPLOAD ZONE ── */}
        <div className="card" style={{ marginBottom:16, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <span className="lbl">Generate News from Media</span>
              <span style={{ fontSize:11, color:"#484F58", marginLeft:8 }}>Upload press note, image, PDF, text file → auto-generate Hindi news</span>
            </div>
            <button className="btn-g" style={{ fontSize:11, padding:"4px 10px" }} onClick={()=>fileRef.current.click()}>+ Upload File</button>
          </div>
          <div
            className={`drop-zone ${dragOver?"over":""}`}
            onDragOver={e=>{e.preventDefault();setDragOver(true)}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={handleDrop}
            onClick={()=>fileRef.current.click()}
            style={{ margin:14, borderRadius:8, padding:"20px 16px" }}
          >
            <input ref={fileRef} type="file" style={{ display:"none" }} accept="image/*,.pdf,.txt,.doc,.docx,video/*,audio/*" onChange={handleFileInput} />
            {mediaLoading ? (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
                <div className="spin-lg" />
                <span style={{ fontSize:13, color:"#8B949E" }}>Reading file & generating Hindi news…</span>
              </div>
            ) : uploadedFile ? (
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:20 }}>
                  {uploadedFile.type.startsWith("image/")?"🖼️":uploadedFile.type==="application/pdf"?"📄":uploadedFile.type.startsWith("video/")?"🎬":uploadedFile.type.startsWith("audio/")?"🎙️":"📝"}
                </span>
                <div>
                  <div style={{ fontSize:13, color:"#E6EDF3", fontWeight:600 }}>{uploadedFile.name}</div>
                  <div style={{ fontSize:11, color:"#484F58" }}>{(uploadedFile.size/1024).toFixed(0)} KB · Click to upload another</div>
                </div>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:28, opacity:.4 }}>📎</span>
                <span style={{ fontSize:13, color:"#6E7681", fontWeight:600 }}>Drop file here or click to upload</span>
                <span style={{ fontSize:11, color:"#484F58" }}>Image · PDF · Text file · Press note · (Video/Audio: extract transcript)</span>
                <span style={{ fontSize:11, color:"#484F58" }}>English or Hindi — news will be written in Hindi</span>
              </div>
            )}
          </div>
        </div>

        {/* Media Result */}
        {mediaResult && !mediaLoading && (
          <div className="card" style={{ marginBottom:16, overflow:"hidden", animation:"fadeIn .3s ease", border:"1px solid #21262D", borderTop:"2px solid #C8102E" }}>
            <div style={{ padding:"10px 16px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#161B22", flexWrap:"wrap", gap:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:12, fontWeight:700, color:"#C8102E", textTransform:"uppercase", letterSpacing:.6 }}>📰 Generated News</span>
                {mediaResult.detected_language && (
                  <span className="tag" style={{ background:"#21262D", color:"#8B949E" }}>Source: {mediaResult.detected_language}</span>
                )}
                <span style={{ fontSize:11, color:"#484F58" }}>{countWords(mediaResult.article||"")} words</span>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-sm" onClick={()=>navigator.clipboard.writeText(mediaResult.article||"")}>Copy</button>
                <button className="btn-g" style={{ fontSize:11, padding:"4px 12px" }} onClick={()=>{setArticle(mediaResult.article||""); setMediaResult(null);}}>Use in Editor ↑</button>
              </div>
            </div>
            <div style={{ padding:"18px 20px", fontSize:16, lineHeight:2.1, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>
              {mediaResult.article}
            </div>
            {mediaResult.pairs?.length > 0 && (
              <div style={{ padding:"0 20px 18px" }}>
                <div className="divider" />
                <div className="lbl" style={{ marginBottom:10 }}>Quick Headlines from Source</div>
                {mediaResult.pairs.map((p, i) => (
                  <div key={i} style={{ padding:"10px 12px", background:"#0D1117", border:"1px solid #21262D", borderRadius:6, marginBottom:8 }}>
                    <div style={{ fontSize:15, fontWeight:700, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", marginBottom:5 }}>{p.headline}</div>
                    <div style={{ fontSize:13, color:"#8B949E", fontFamily:"'Noto Serif Devanagari',serif" }}>{p.subheadline}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── EDITOR ── */}
        <div className="card" style={{ marginBottom: rwOpen ? 0 : 16, borderRadius: rwOpen ? "10px 10px 0 0" : 10 }}>
          <div style={{ padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:8 }}>
              <span className="lbl">Story Editor</span>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <span className="lbl" style={{ color:"#484F58" }}>Story Limit</span>
                <input type="number" className="ninp" placeholder="words" value={storyLimit} onChange={e=>setStoryLimit(e.target.value)} min="0" />
                <button className="btn-g" style={{ fontSize:11, padding:"5px 10px" }} onClick={translateToHindi} disabled={transLoading||!article.trim()}>
                  {transLoading ? <><div className="spin" />Translating…</> : "🌐 → Hindi"}
                </button>
                <button className="btn-g" style={{ fontSize:11, padding:"5px 10px", borderColor: rwOpen?"#C8102E":"#30363D", color:rwOpen?"#C8102E":"#8B949E" }} onClick={()=>setRwOpen(o=>!o)}>
                  {rwOpen ? "✕ Close Rewrite" : "✍ Rewrite"}
                </button>
              </div>
            </div>

            <textarea ref={editorRef} className="inp" style={{ minHeight:200 }} value={article} onChange={e=>setArticle(e.target.value)} onKeyDown={handleKeyDown} placeholder="यहाँ अपना समाचार लिखें... (Hindi or English — write your news story here)" spellCheck={false} />

            {apiError && (
              <div style={{ marginTop:10, background:"#2D1117", border:"1px solid #7D2A2A", borderRadius:6, padding:"9px 14px", color:"#F87171", fontSize:13, lineHeight:1.5 }}>⚠ {apiError}</div>
            )}

            <div style={{ marginTop:12, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                <span style={{ fontSize:11, color:"#484F58" }}>Ctrl+Enter to analyse</span>
                {analysis?.seo_keywords?.length > 0 && (
                  <div style={{ display:"flex", gap:4 }}>
                    {analysis.seo_keywords.slice(0,3).map((k,i)=>(
                      <span key={i} className="tag" style={{ background:"#21262D", color:"#8B949E", fontSize:10 }}>{k}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-g" style={{ fontSize:11 }} onClick={()=>{saveVersion(article,"Manual save"); }}>💾 Save</button>
                <button className="btn-red" onClick={analyse} disabled={loading||!article.trim()}>
                  {loading ? <><div className="spin" />{loadingMsg||"Analysing…"}</> : <>⚡ Analyse Story</>}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── REWRITE PANEL (inline below editor) ── */}
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
              <textarea className="tinp" value={rwPrompt} onChange={e=>setRwPrompt(e.target.value)} placeholder="Instructions e.g. make it front-page worthy, add emotional angle, shorten for online, focus on local reader…" rows={2} />
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
                    <span style={{ fontSize:11, color:"#6E7681" }}>Display limit</span>
                    <input type="number" className="ninp" placeholder="words" value={rwDispLimit} onChange={e=>setRwDispLimit(e.target.value)} min="0" />
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

        {/* Translation Result */}
        {transResult && (
          <div className="card" style={{ marginBottom:16, animation:"fadeIn .3s ease", border:"1px solid #21262D", borderTop:"2px solid #3B82F6" }}>
            <div style={{ padding:"10px 16px", borderBottom:"1px solid #21262D", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#161B22" }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#3B82F6", textTransform:"uppercase" }}>🌐 Hindi Translation & Rewrite</span>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-sm" onClick={()=>navigator.clipboard.writeText(transResult.article||"")}>Copy</button>
                <button className="btn-g" style={{ fontSize:11, padding:"4px 12px" }} onClick={()=>{setArticle(transResult.article||""); setTransResult(null);}}>Use in Editor ↑</button>
              </div>
            </div>
            <div style={{ padding:"18px 20px", fontSize:16, lineHeight:2.1, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>
              {transResult.article}
            </div>
          </div>
        )}

        {/* ── RESULTS TABS ── */}
        {analysis && !loading && (
          <div className="card" style={{ overflow:"hidden", animation:"fadeIn .3s ease" }}>
            <div style={{ display:"flex", borderBottom:"1px solid #21262D", background:"#0D1117", overflowX:"auto" }}>
              {[
                { k:"grammar", label:"Grammar Check", badge: errCount>0?errCount:null, bc:"#CF222E" },
                { k:"headlines", label:"Headlines & Subheads", badge:displayPairs.length||null, bc:"#C8102E" },
              ].map(t => (
                <button key={t.k} className={`tab ${activeTab===t.k?"on":""}`} onClick={()=>setActiveTab(t.k)}>
                  {t.label}
                  {t.badge!=null && <span style={{ background:activeTab===t.k?t.bc:"#21262D", color:activeTab===t.k?"#fff":"#6E7681", borderRadius:20, padding:"1px 7px", fontSize:10, marginLeft:6, fontWeight:700 }}>{t.badge}</span>}
                </button>
              ))}
              {analysis.missing_elements?.length > 0 && (
                <button className={`tab ${activeTab==="missing"?"on":""}`} onClick={()=>setActiveTab("missing")} style={{ color: activeTab==="missing"?"#F87171":"#6E7681" }}>
                  ⚠ Missing Elements
                  <span style={{ background: activeTab==="missing"?"#CF222E":"#21262D", color: activeTab==="missing"?"#fff":"#6E7681", borderRadius:20, padding:"1px 7px", fontSize:10, marginLeft:6, fontWeight:700 }}>{analysis.missing_elements.length}</span>
                </button>
              )}
            </div>

            <div style={{ padding:"22px 24px" }}>

              {/* ── GRAMMAR ── */}
              {activeTab==="grammar" && (
                <div style={{ animation:"fadeIn .25s ease" }}>
                  {analysis.summary && (
                    <div style={{ background:"#0D1117", border:"1px solid #21262D", borderLeft:"3px solid #C8102E", borderRadius:"0 8px 8px 0", padding:"12px 16px", marginBottom:18 }}>
                      <div className="lbl" style={{ color:"#C8102E", marginBottom:6 }}>Editorial Feedback</div>
                      <p style={{ fontSize:15, lineHeight:1.9, color:"#C9D1D9", fontFamily:"'Noto Serif Devanagari',serif" }}>{analysis.summary}</p>
                    </div>
                  )}
                  {storyLimit && parseInt(storyLimit)>0 && (
                    <div style={{ marginBottom:14, background:"#161B22", border:"1px solid #21262D", borderRadius:6, padding:"8px 14px", display:"flex", alignItems:"center", gap:8, fontSize:12 }}>
                      <span style={{ color:"#6E7681" }}>Word limit active:</span>
                      <span style={{ color:"#58A6FF", fontWeight:700 }}>{storyLimit} words</span>
                      {overLimit && <span style={{ color:"#F87171", fontWeight:600, marginLeft:"auto" }}>⚠ {words-parseInt(storyLimit)} words over</span>}
                    </div>
                  )}
                  {hasErrors && (
                    <div style={{ display:"flex", gap:14, marginBottom:14, alignItems:"center", flexWrap:"wrap" }}>
                      <span className="lbl">Legend:</span>
                      <span style={{ fontSize:13, fontFamily:"'Noto Serif Devanagari',serif" }}>
                        <span className="err-w" style={{ cursor:"default" }}>गलत</span>
                        <span className="err-b"> [</span><span className="err-f">सही</span><span className="err-b">]</span>
                      </span>
                      <span style={{ fontSize:11, color:"#484F58" }}>Hover red word for reason</span>
                    </div>
                  )}
                  {!hasErrors ? (
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                        <span style={{ color:"#4ADE80", fontSize:16 }}>✓</span>
                        <span style={{ fontSize:13, color:"#4ADE80", fontWeight:600 }}>No grammar errors found</span>
                      </div>
                      <div style={{ background:"#0D1117", border:"1px solid #21262D", borderRadius:8, padding:"18px 20px", fontSize:16, lineHeight:2.2, color:"#E6EDF3", fontFamily:"'Noto Serif Devanagari',serif", whiteSpace:"pre-wrap" }}>{limitedText}</div>
                    </div>
                  ) : (
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
                    <textarea className="tinp" value={hlPrompt} onChange={e=>setHlPrompt(e.target.value)} placeholder="Custom instruction e.g. dramatic tone, political angle, Madhya Pradesh audience, election focus…" rows={2} />
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

        {/* Loading */}
        {loading && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, padding:"36px 0" }}>
            <div className="spin-lg" />
            <span style={{ fontSize:14, color:"#8B949E" }}>{loadingMsg||"Analysing…"}</span>
          </div>
        )}

        {/* Empty state */}
        {!analysis && !loading && !mediaResult && !transResult && (
          <div style={{ textAlign:"center", padding:"40px 0" }}>
            <div style={{ fontSize:40, opacity:.1, marginBottom:12 }}>📰</div>
            <div style={{ fontSize:14, color:"#484F58", fontWeight:500 }}>Write your story or upload a file to get started</div>
            <div style={{ fontSize:12, color:"#30363D", marginTop:6 }}>Grammar · 20 Headlines · DB Rewrite · Media-to-News · Translate → Hindi</div>
          </div>
        )}
      </div>

      <div style={{ borderTop:"1px solid #21262D", padding:"12px 28px", textAlign:"center" }}>
        <div style={{ fontSize:10, color:"#30363D", letterSpacing:.8, textTransform:"uppercase" }}>Dainik Bhaskar NewsDesk · AI-Powered by Claude · Professional Reporter Suite</div>
      </div>
    </div>
  );
}