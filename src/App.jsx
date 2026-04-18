import React, { useState, useRef, useCallback, useEffect } from "react";

// ─── API & SYSTEM CONFIG ──────────────────────────────────────────────────

// Exponential backoff fetcher (Enterprise stability)
async function fetchWithRetry(url, options) {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (i === 5) throw err;
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
}

async function callGemini(apiKey, systemInstruction, userPrompt, base64Data = null, mimeType = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  
  const parts = [{ text: userPrompt }];
  if (base64Data && mimeType) {
    parts.push({ inlineData: { mimeType, data: base64Data } });
  }

  const payload = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const data = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Invalid response from Gemini API");
  
  try {
    return JSON.parse(text);
  } catch (e) {
    // Fallback if model wraps in markdown despite JSON config
    let s = text.replace(/```json|```/gi, "").trim();
    return JSON.parse(s);
  }
}

// ─── DB EDITORIAL STYLE (shared) ──────────────────────────────────────────
const DB_STYLE = `
DAINIK BHASKAR EDITORIAL STYLE (MANDATORY):
1. LEAD: Answer कौन/क्या/कहाँ/कब/क्यों in first 2-3 lines. Most important fact FIRST.
2. LANGUAGE: Simple Khari Boli Hindi. Short sentences ≤20 words. Active voice.
3. TONE: Authoritative, accessible, never sensational. Facts-first.
4. STRUCTURE: Lead → Key facts → Background → Quote → Impact/What next.
5. NUMBERS: Always digits (5 not पाँच). ₹ symbol. % for percentages.
6. ATTRIBUTION: Every claim needs source — "पुलिस के अनुसार".
7. QUOTES: Direct quotes from named sources only. In quotation marks.
8. AVOID: Redundancy, passive voice, vague phrases.`;

// ─── PROMPTS ───────────────────────────────────────────────────────────────

const ANALYSIS_PROMPT = `You are an expert Hindi language editor and fact-checker for Dainik Bhaskar.
CRITICAL TASK: Check for FACTUAL INCONSISTENCIES. Look for mismatched numbers (e.g., headline says 10000, body says 100), mismatched names, or illogical timelines.

Respond ONLY with a valid JSON object matching this schema exactly:
{
  "errors": [ { "original": "exact substring", "correction": "corrected text", "explanation": "grammar reason" } ],
  "fact_checks": [ { "claim": "What is conflicting", "issue": "Why it's wrong/inconsistent", "suggestion": "How to fix" } ],
  "pairs": [ { "headline": "Hindi headline", "subheadline": "sub-headline", "style": "breaking|informative|dramatic|soft|question|statistic", "angle": "one word", "score": 90 } ],
  "summary": "2-3 sentence editorial feedback in Hindi",
  "seo_keywords": ["kw1","kw2"],
  "story_category": "politics|crime|sports|health|business|local|national|international|entertainment",
  "missing_elements": ["missing journalistic element"]
}
Rules: Generate EXACTLY 5 headline pairs. Score 1-100.`;

const REWRITE_PROMPT = `You are a senior state editor at Dainik Bhaskar.
${DB_STYLE}
Respond ONLY with valid JSON schema: { "rewritten": "full DB-style Hindi article" }`;

const MEDIA_TO_NEWS_PROMPT = `You are a senior reporter at Dainik Bhaskar newspaper.
${DB_STYLE}
Task: Extract factual info from the content, translate if English, and write a DB-style Hindi news article.
Ensure facts (numbers, names) are strictly accurate and consistent.

Respond ONLY with valid JSON schema:
{
  "article": "complete Hindi news article",
  "pairs": [ { "headline": "Hindi headline", "subheadline": "Hindi sub-headline", "style": "informative", "score": 90 } ],
  "summary": "brief note about the source",
  "detected_language": "Hindi|English|Mixed"
}`;

// ─── HELPERS ───────────────────────────────────────────────────────────────
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

// ─── COMPONENT ───────────────────────────────────────────────────────────────
export default function App() {
  const [userApiKey, setUserApiKey] = useState(() => {
    try { return localStorage.getItem("db_gemini_api_key") || ""; } catch { return ""; }
  });
  const [showSetup, setShowSetup] = useState(!userApiKey);
  const [mainTab, setMainTab] = useState("editor"); // 'editor' | 'whatsapp'
  
  // Editor State
  const [article, setArticle] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [progress, setProgress] = useState(0);
  const [apiError, setApiError] = useState(null);
  const [activeTab, setActiveTab] = useState("grammar");
  const [storyLimit, setStoryLimit] = useState("");

  // Rewrite / Media State
  const [rwOpen, setRwOpen] = useState(false);
  const [rwPrompt, setRwPrompt] = useState("");
  const [rwResult, setRwResult] = useState(null);
  
  const [mediaResult, setMediaResult] = useState(null);
  const fileRef = useRef(null);

  // WhatsApp State
  const [waNumberLinked, setWaNumberLinked] = useState("");
  const [waMessages, setWaMessages] = useState([]);
  const [selectedWa, setSelectedWa] = useState(null);
  const [waProcessing, setWaProcessing] = useState(false);

  const handleSaveKey = () => {
    if (userApiKey.trim()) {
      try { localStorage.setItem("db_gemini_api_key", userApiKey.trim()); } catch (e) {}
      setShowSetup(false);
    }
  };

  // Progress Bar Simulation Effect
  useEffect(() => {
    let interval;
    if (loading) {
      setProgress(0);
      interval = setInterval(() => {
        setProgress(p => (p < 90 ? p + (90 - p) * 0.1 : p));
      }, 300);
    } else {
      setProgress(100);
      setTimeout(() => setProgress(0), 500); // Hide after complete
    }
    return () => clearInterval(interval);
  }, [loading]);

  const clearAll = () => {
    setArticle(""); setAnalysis(null); setSegments([]); setApiError(null);
    setRwResult(null); setMediaResult(null); setRwOpen(false);
  };

  // ── Analyse ──
  const analyse = useCallback(async () => {
    if (article.trim().length < 20) { setApiError("Please write at least 20 characters."); return; }
    setLoading(true); setLoadingMsg("Analyzing Grammar & Facts…"); setApiError(null);
    try {
      const parsed = await callGemini(userApiKey, ANALYSIS_PROMPT, `Analyse this news article:\n\n${article}`);
      setAnalysis(parsed);
      setSegments(buildSegments(article, parsed.errors || []));
      
      // Auto-switch to fact checks if there are errors, otherwise grammar
      if (parsed.fact_checks && parsed.fact_checks.length > 0) setActiveTab("facts");
      else setActiveTab("grammar");
      
    } catch (e) { setApiError(`Error: ${e.message}`); }
    finally { setLoading(false); setLoadingMsg(""); }
  }, [article, userApiKey]);

  // ── Rewrite ──
  const rewrite = useCallback(async () => {
    if (!article.trim()) return;
    setLoading(true); setLoadingMsg("Rewriting Story…"); setApiError(null);
    try {
      let instr = rwPrompt.trim() || "Rewrite in professional Dainik Bhaskar style.";
      if (storyLimit) instr += ` STRICT word limit: max ${storyLimit} words.`;
      const parsed = await callGemini(userApiKey, REWRITE_PROMPT, `Instruction: ${instr}\n\nArticle:\n${article}`);
      setRwResult(parsed.rewritten || "");
    } catch (e) { setApiError(`Rewrite Error: ${e.message}`); }
    finally { setLoading(false); setLoadingMsg(""); }
  }, [article, rwPrompt, storyLimit, userApiKey]);

  // ── Process Media (Pressnotes) ──
  const processMedia = useCallback(async (file) => {
    setLoading(true); setLoadingMsg("Extracting News from Media…"); setApiError(null);
    try {
      const isImage = file.type.startsWith("image/");
      const isPDF = file.type === "application/pdf";
      const isText = file.type.startsWith("text/") || file.name.endsWith(".txt");

      let parsed;
      if (isImage || isPDF) {
        const b64 = await toBase64(file);
        parsed = await callGemini(userApiKey, MEDIA_TO_NEWS_PROMPT, "Extract news and rewrite in Hindi.", b64, file.type);
      } else if (isText) {
        const text = await file.text();
        parsed = await callGemini(userApiKey, MEDIA_TO_NEWS_PROMPT, `Extract news and rewrite in Hindi:\n\n${text}`);
      } else {
        throw new Error("Unsupported file format.");
      }
      
      setMediaResult(parsed);
      setArticle(parsed.article); // Auto-fill editor
    } catch (e) { setApiError(`Media Error: ${e.message}`); }
    finally { setLoading(false); setLoadingMsg(""); }
  }, [userApiKey]);

  const handleFileInput = e => {
    const file = e.target.files[0];
    if (file) processMedia(file);
    e.target.value = null; // reset
  };

  // ── WhatsApp Integration Sim ──
  const simulateWhatsAppMsg = () => {
    const dummyNews = `Police raid in Jaipur city today. 10000 liters of illegal alcohol seized from a warehouse in Mansarovar. 5 people arrested including main accused Ramesh. Inspector Sharma said the value is approx Rs 50 Lakhs. Operations started at 3 AM.`;
    const newMsg = {
      id: Date.now(),
      sender: waNumberLinked || "+91 98765 43210",
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      content: dummyNews,
      status: "new"
    };
    setWaMessages([newMsg, ...waMessages]);
  };

  const openWaMessage = async (msg) => {
    setSelectedWa(msg);
    if (msg.status === "new") {
      setWaProcessing(true);
      try {
        const parsed = await callGemini(userApiKey, MEDIA_TO_NEWS_PROMPT, `WhatsApp Forward:\n\n${msg.content}`);
        const updatedMsgs = waMessages.map(m => m.id === msg.id ? { ...m, status: "processed", rewritten: parsed.article } : m);
        setWaMessages(updatedMsgs);
        setSelectedWa(updatedMsgs.find(m => m.id === msg.id));
      } catch (e) {
        alert("Failed to process WhatsApp message: " + e.message);
      } finally {
        setWaProcessing(false);
      }
    }
  };

  // Computed values
  const words = countWords(article);
  const overLimit = storyLimit && parseInt(storyLimit) > 0 && words > parseInt(storyLimit);
  const hasErrors = segments.some(s => s.type === "error");
  const errCount = segments.filter(s => s.type === "error").length;
  const factCount = analysis?.fact_checks?.length || 0;
  const displayPairs = analysis?.pairs || [];

  if (showSetup) {
    return (
      <div className="min-h-screen bg-[#0D1117] flex items-center justify-center p-6 text-[#E6EDF3] font-['Inter',sans-serif]">
        <div className="card max-w-md w-full p-8 shadow-2xl border border-[#30363D]">
          <div className="flex justify-center mb-6 text-5xl">📰</div>
          <h1 className="text-2xl font-bold text-center mb-2">Welcome to DB NewsDesk</h1>
          <p className="text-sm text-[#8B949E] text-center mb-8">AI Reporter Suite powered by Google Gemini.</p>
          
          <div className="mb-6">
            <label className="lbl block mb-2">Google Gemini API Key</label>
            <input 
              type="password" 
              value={userApiKey} 
              onChange={e => setUserApiKey(e.target.value)}
              placeholder="AIzaSy..." 
              className="w-full bg-[#0D1117] border border-[#30363D] rounded-md px-4 py-3 text-sm text-white focus:border-[#C8102E] outline-none transition-colors"
            />
          </div>
          
          <button 
            onClick={handleSaveKey}
            disabled={!userApiKey.trim()}
            className="w-full btn-red justify-center py-3 text-sm mb-6"
          >
            Access NewsDesk
          </button>

          <div className="bg-[#1C2128] border border-[#21262D] rounded p-4 text-xs text-[#8B949E] leading-relaxed">
            <span className="font-bold text-[#C9D1D9]">How to get an API key:</span>
            <ol className="list-decimal ml-4 mt-2 space-y-1">
              <li>Go to <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[#58A6FF] hover:underline">Google AI Studio</a></li>
              <li>Sign in with your Google Account</li>
              <li>Click "Create API Key" and copy it here</li>
            </ol>
            <p className="mt-3 text-[#6E7681]">Your key is stored securely in your browser's local storage and is only used to communicate directly with Google's API.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0D1117] text-[#E6EDF3] font-['Inter',sans-serif]">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+Devanagari:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap');
        .editor-inp { background:#161B22; border:1px solid #30363D; border-radius:8px; color:#E6EDF3; font-size:16px; line-height:2.1; padding:16px 18px; font-family:'Noto Serif Devanagari',serif; resize:vertical; outline:none; transition:all 0.2s; width:100%; }
        .editor-inp:focus { border-color:#C8102E; box-shadow:0 0 0 2px rgba(200,16,46,0.1); }
        .card { background:#161B22; border:1px solid #21262D; border-radius:10px; }
        .lbl { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.2px; color:#6E7681; }
        .btn-red { background:linear-gradient(135deg,#C8102E,#E53E3E); color:#fff; padding:8px 18px; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.2s; display:inline-flex; align-items:center; gap:6px; border:none; }
        .btn-red:hover:not(:disabled) { filter:brightness(1.15); transform:translateY(-1px); }
        .btn-red:disabled { opacity:0.5; cursor:not-allowed; }
        .btn-g { background:transparent; color:#8B949E; border:1px solid #30363D; padding:8px 14px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.18s; display:inline-flex; align-items:center; gap:5px; }
        .btn-g:hover:not(:disabled) { background:#21262D; border-color:#58A6FF; color:#58A6FF; }
        .err-w { color:#FF6B6B; background:rgba(255,107,107,.12); border-bottom:2px solid #FF4444; border-radius:3px 3px 0 0; padding:0 2px; cursor:help; font-weight:600; }
        .err-b { color:#484F58; font-size:.9em; }
        .err-f { color:#4ADE80; background:rgba(74,222,128,.1); border-bottom:2px solid #22C55E; border-radius:3px 3px 0 0; padding:0 2px; font-weight:700; }
        .tab { background:none; border:none; cursor:pointer; padding:12px 20px; font-size:12px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#6E7681; border-bottom:2px solid transparent; transition:0.2s; }
        .tab.active { color:#E6EDF3; border-bottom-color:#C8102E; background:#1C2128; }
        .tab:hover:not(.active) { color:#C9D1D9; background:#161B22; }
        .progress-bar { height:3px; background:#C8102E; transition:width 0.3s ease, opacity 0.3s ease; }
        .wa-msg:hover { background: #21262D; cursor: pointer; }
      `}</style>

      {/* ── HEADER NAVIGATION ── */}
      <div className="bg-[#161B22] border-b border-[#21262D] px-6 sticky top-0 z-50">
        <div className="max-w-5xl mx-auto h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 bg-gradient-to-br from-[#C8102E] to-red-900 rounded flex items-center justify-center text-lg">📰</div>
            <div>
              <div className="font-extrabold text-sm text-[#E6EDF3] tracking-tight">Dainik Bhaskar NewsDesk</div>
              <div className="text-[10px] text-[#484F58] tracking-widest uppercase">AI Reporter Suite</div>
            </div>
            
            <div className="ml-6 flex space-x-2">
            <button className={`px-4 py-1 text-xs font-bold rounded-full ${mainTab === 'editor' ? 'bg-[#C8102E] text-white' : 'bg-transparent text-[#8B949E] hover:bg-[#21262D]'}`} onClick={() => setMainTab('editor')}>🖋️ AI Editor</button>
            <button className={`px-4 py-1 text-xs font-bold rounded-full flex items-center gap-2 ${mainTab === 'whatsapp' ? 'bg-[#25D366] text-black' : 'bg-transparent text-[#8B949E] hover:bg-[#21262D]'}`} onClick={() => setMainTab('whatsapp')}>
              💬 WhatsApp Inbox
              {waMessages.filter(m=>m.status==='new').length > 0 && <span className="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded-full">{waMessages.filter(m=>m.status==='new').length}</span>}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-g text-xs py-1" onClick={() => setShowSetup(true)}>⚙️ API Key</button>
          <button className="btn-g text-xs py-1" onClick={clearAll}>Reset Canvas</button>
        </div>
      </div>
      
      {/* Global Progress Bar */}
        <div className="absolute bottom-0 left-0 w-full h-[2px] bg-[#0D1117]">
            <div className="progress-bar" style={{ width: `${progress}%`, opacity: progress > 0 && progress < 100 ? 1 : 0 }} />
        </div>
      </div>

      <div className="max-w-5xl mx-auto py-6 px-6">
        
        {/* =======================================================================================
            MAIN EDITOR VIEW
            ======================================================================================= */}
        {mainTab === 'editor' && (
          <div className="space-y-4">
            
            {/* Toolbar above editor */}
            <div className="flex justify-between items-end mb-2">
              <div>
                <span className="lbl text-[#E6EDF3]">Live Story Canvas</span>
                <p className="text-xs text-[#6E7681] mt-1">Keep writing while AI works. Paste content or upload media.</p>
              </div>
              <div className="flex gap-2 items-center">
                <input type="number" placeholder="Word limit" value={storyLimit} onChange={e=>setStoryLimit(e.target.value)} className="bg-[#161B22] border border-[#30363D] rounded px-3 py-1.5 text-xs text-white w-24 outline-none focus:border-[#58A6FF]" />
                
                {/* INLINE MEDIA UPLOAD */}
                <input ref={fileRef} type="file" className="hidden" accept="image/*,.pdf,.txt,.doc,.docx" onChange={handleFileInput} />
                <button className="btn-g" onClick={() => fileRef.current.click()}>
                  📎 Upload Pressnote
                </button>

                <button className="btn-red" onClick={analyse} disabled={loading || !article.trim()}>
                  {loading ? (
                    <><svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    {loadingMsg || "Analyzing..."}</>
                  ) : "⚡ Analyze Story"}
                </button>
              </div>
            </div>

            {/* API Error Alert */}
            {apiError && (
              <div className="bg-red-900/30 border border-red-500 text-red-200 px-4 py-3 rounded text-sm mb-4">
                ⚠ {apiError}
              </div>
            )}

            {/* Word Count Pill */}
            <div className="absolute mt-2 mr-2 right-[20%] z-10 pointer-events-none">
               <div className={`px-3 py-1 rounded-full text-xs font-bold border backdrop-blur-md ${overLimit ? 'bg-red-900/50 border-red-500 text-red-300' : 'bg-[#161B22]/80 border-[#30363D] text-[#8B949E]'}`}>
                 {words} words {storyLimit ? `/ ${storyLimit}` : ''}
               </div>
            </div>

            {/* Text Editor */}
            <textarea 
              className="editor-inp min-h-[250px]" 
              value={article} 
              onChange={e => setArticle(e.target.value)} 
              placeholder="यहाँ अपना समाचार लिखें... (Hindi or English — write your news story here)" 
              spellCheck={false} 
            />

            {/* AI Results Section */}
            {analysis && (
              <div className="card mt-6 overflow-hidden animate-[fadeIn_0.3s_ease]">
                <div className="flex border-b border-[#21262D] bg-[#0D1117] overflow-x-auto">
                  <button className={`tab ${activeTab === 'grammar' ? 'active' : ''}`} onClick={() => setActiveTab('grammar')}>
                    Grammar & Style {errCount > 0 && <span className="ml-2 bg-red-600 text-white px-1.5 py-0.5 rounded-full text-[10px]">{errCount}</span>}
                  </button>
                  <button className={`tab ${activeTab === 'facts' ? 'active' : ''}`} onClick={() => setActiveTab('facts')}>
                    Fact Checks {factCount > 0 && <span className="ml-2 bg-yellow-600 text-white px-1.5 py-0.5 rounded-full text-[10px]">{factCount}</span>}
                  </button>
                  <button className={`tab ${activeTab === 'headlines' ? 'active' : ''}`} onClick={() => setActiveTab('headlines')}>
                    Headlines
                  </button>
                  <button className={`tab ${activeTab === 'rewrite' ? 'active' : ''}`} onClick={() => setActiveTab('rewrite')}>
                    Rewrite Module
                  </button>
                </div>

                <div className="p-6">
                  {/* GRAMMAR TAB */}
                  {activeTab === 'grammar' && (
                    <div>
                      {analysis.summary && (
                        <div className="bg-[#0D1117] border-l-4 border-[#C8102E] p-4 mb-4 rounded-r-md">
                          <div className="lbl text-[#C8102E] mb-2">Editorial Feedback</div>
                          <p className="text-sm leading-relaxed text-[#C9D1D9] font-['Noto_Serif_Devanagari']">{analysis.summary}</p>
                        </div>
                      )}
                      {!hasErrors ? (
                         <div className="text-green-400 font-bold text-sm">✓ No grammatical errors found. Story conforms to Dainik Bhaskar style.</div>
                      ) : (
                         <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-5 text-base leading-loose font-['Noto_Serif_Devanagari'] text-[#E6EDF3] whitespace-pre-wrap">
                          {segments.map((seg, i) => {
                            if (seg.type === "normal") return <span key={i}>{seg.text}</span>;
                            return (
                              <span key={i} title={seg.explanation || ""} className="cursor-help">
                                <span className="err-w">{seg.original}</span>
                                <span className="err-b"> [</span><span className="err-f">{seg.correction}</span><span className="err-b">] </span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* FACTS TAB */}
                  {activeTab === 'facts' && (
                    <div>
                       <div className="mb-4 text-sm text-[#8B949E]">
                         AI verifies inconsistencies in your draft (e.g. "Headline says 10000, body says 100").
                       </div>
                       {factCount === 0 ? (
                         <div className="text-green-400 font-bold text-sm p-4 border border-green-900/30 bg-green-900/10 rounded">✓ No factual inconsistencies or conflicting numbers detected.</div>
                       ) : (
                         <div className="space-y-3">
                           {analysis.fact_checks.map((fact, i) => (
                             <div key={i} className="bg-[#1C1917] border border-[#44403C] border-l-4 border-l-yellow-500 rounded p-4">
                               <div className="flex items-start gap-3">
                                 <div className="text-yellow-500 mt-1">⚠</div>
                                 <div>
                                    <div className="text-sm font-bold text-[#E6EDF3] mb-1">Conflict: {fact.claim}</div>
                                    <div className="text-sm text-[#A8A29E] mb-2">Issue: {fact.issue}</div>
                                    <div className="text-xs text-yellow-500 bg-yellow-900/20 inline-block px-2 py-1 rounded">Suggestion: {fact.suggestion}</div>
                                 </div>
                               </div>
                             </div>
                           ))}
                         </div>
                       )}
                    </div>
                  )}

                  {/* HEADLINES TAB */}
                  {activeTab === 'headlines' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {displayPairs.map((p, i) => (
                        <div key={i} className="bg-[#0D1117] border border-[#21262D] rounded-lg p-4 hover:border-[#30363D] transition-colors">
                          <div className="flex justify-between items-center mb-3">
                            <span className="text-[10px] bg-[#21262D] text-[#8B949E] px-2 py-1 rounded uppercase font-bold">{p.style || "Standard"}</span>
                            <span className={`text-xs font-bold ${p.score >= 80 ? 'text-green-400' : 'text-yellow-500'}`}>Score: {p.score}</span>
                          </div>
                          <h4 className="text-lg font-bold font-['Noto_Serif_Devanagari'] text-[#E6EDF3] mb-2 leading-snug">{p.headline}</h4>
                          <p className="text-sm text-[#8B949E] font-['Noto_Serif_Devanagari'] leading-relaxed">{p.subheadline}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* REWRITE TAB */}
                  {activeTab === 'rewrite' && (
                    <div className="max-w-2xl">
                      <div className="mb-4">
                        <label className="lbl block mb-2">Special Instructions for Rewrite</label>
                        <textarea className="w-full bg-[#161B22] border border-[#30363D] rounded-md p-3 text-sm text-white focus:border-[#58A6FF] outline-none" rows="2" placeholder="e.g. Focus on the emotional angle, make it suitable for front page..." value={rwPrompt} onChange={e=>setRwPrompt(e.target.value)} />
                      </div>
                      <button className="btn-red mb-6" onClick={rewrite} disabled={loading}>✍ Generate Fresh Rewrite</button>
                      
                      {rwResult && (
                        <div className="bg-[#0D1117] border border-green-900/30 rounded-lg p-5">
                           <div className="flex justify-between items-center mb-3">
                             <div className="text-xs font-bold text-green-400 uppercase tracking-widest">Rewritten Version</div>
                             <button className="btn-g text-[10px] py-1 px-2" onClick={() => { setArticle(rwResult); setActiveTab('grammar'); }}>Use This Content ↑</button>
                           </div>
                           <p className="text-base font-['Noto_Serif_Devanagari'] text-[#E6EDF3] leading-loose whitespace-pre-wrap">{rwResult}</p>
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </div>
            )}
          </div>
        )}


        {/* =======================================================================================
            WHATSAPP INBOX VIEW
            ======================================================================================= */}
        {mainTab === 'whatsapp' && (
          <div className="h-[80vh] flex flex-col md:flex-row gap-6">
            
            {/* Sidebar Inbox */}
            <div className="w-full md:w-1/3 flex flex-col gap-4">
              <div className="card p-4">
                <div className="lbl mb-2">Link WhatsApp Webhook</div>
                <div className="flex gap-2">
                  <input type="text" placeholder="Enter Phone No." value={waNumberLinked} onChange={e=>setWaNumberLinked(e.target.value)} className="flex-1 bg-[#0D1117] border border-[#30363D] rounded px-3 py-1.5 text-sm text-white outline-none" />
                  <button className="bg-[#25D366] text-black font-bold text-xs px-3 rounded hover:bg-[#1DA851] transition">Link</button>
                </div>
                <div className="mt-4 pt-4 border-t border-[#21262D]">
                  <button className="w-full btn-g text-center justify-center text-xs" onClick={simulateWhatsAppMsg}>
                    🔄 Simulate Incoming Pressnote
                  </button>
                </div>
              </div>

              <div className="card flex-1 overflow-y-auto">
                <div className="p-3 border-b border-[#21262D] sticky top-0 bg-[#161B22] font-bold text-sm text-[#E6EDF3]">Inbox ({waMessages.length})</div>
                {waMessages.length === 0 ? (
                  <div className="text-center p-8 text-[#484F58] text-xs">No pending messages. Link number or simulate.</div>
                ) : (
                  <div className="flex flex-col">
                    {waMessages.map(msg => (
                      <div key={msg.id} className={`wa-msg p-4 border-b border-[#21262D] ${selectedWa?.id === msg.id ? 'bg-[#21262D]' : ''}`} onClick={() => openWaMessage(msg)}>
                        <div className="flex justify-between items-start mb-1">
                          <span className="text-xs font-bold text-white">{msg.sender}</span>
                          <span className="text-[10px] text-[#8B949E]">{msg.time}</span>
                        </div>
                        <div className="text-xs text-[#8B949E] line-clamp-2">{msg.content}</div>
                        {msg.status === "new" && <span className="inline-block mt-2 bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">Unprocessed</span>}
                        {msg.status === "processed" && <span className="inline-block mt-2 bg-green-600 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">Processed</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Split Screen Content */}
            <div className="w-full md:w-2/3 flex flex-col">
              {!selectedWa ? (
                <div className="card h-full flex flex-col items-center justify-center text-[#484F58]">
                  <div className="text-4xl mb-4">📱</div>
                  <div>Select a WhatsApp message to process</div>
                </div>
              ) : (
                <div className="card flex-1 flex flex-col overflow-hidden">
                  <div className="p-4 border-b border-[#21262D] bg-[#0D1117] flex justify-between items-center">
                    <div>
                      <span className="text-white font-bold text-sm mr-2">{selectedWa.sender}</span>
                      <span className="text-xs text-[#8B949E]">{selectedWa.time}</span>
                    </div>
                    {selectedWa.status === "processed" && (
                      <button className="btn-red text-[10px] py-1 px-3" onClick={() => {
                        setArticle(selectedWa.rewritten);
                        setMainTab('editor');
                      }}>✏️ Move to Editor</button>
                    )}
                  </div>
                  
                  <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                    {/* Left: Original WhatsApp */}
                    <div className="w-full md:w-1/2 p-4 md:border-r border-[#21262D] overflow-y-auto bg-[#1C2128]">
                      <div className="lbl mb-4 text-[#8B949E]">Original WhatsApp Forward</div>
                      <div className="bg-[#0D1117] p-4 rounded-lg border border-[#30363D] text-sm text-[#C9D1D9] whitespace-pre-wrap leading-relaxed relative">
                        <div className="absolute top-2 right-2 opacity-20 text-2xl">💬</div>
                        {selectedWa.content}
                      </div>
                    </div>
                    
                    {/* Right: AI Rewritten News */}
                    <div className="w-full md:w-1/2 p-4 overflow-y-auto bg-[#161B22]">
                      <div className="lbl mb-4 text-[#25D366]">Dainik Bhaskar Formatted News</div>
                      
                      {waProcessing ? (
                        <div className="flex flex-col items-center justify-center h-40 gap-3">
                          <svg className="animate-spin h-6 w-6 text-[#25D366]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                          <span className="text-sm text-[#8B949E]">Converting to press format...</span>
                        </div>
                      ) : selectedWa.status === "processed" ? (
                        <div className="bg-[#0D1117] p-5 rounded-lg border border-green-900/30 text-base text-[#E6EDF3] font-['Noto_Serif_Devanagari'] leading-loose whitespace-pre-wrap">
                          {selectedWa.rewritten}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}