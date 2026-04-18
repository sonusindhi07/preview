import React, { useState, useEffect } from 'react';
import { 
  PenTool, 
  CheckCircle, 
  Type, 
  LayoutTemplate, 
  AlertCircle, 
  Loader2, 
  Copy, 
  Check,
  RefreshCw,
  FileText,
  Share2,
  Zap,
  ChevronRight,
  Target,
  History,
  Settings,
  Key,
  X
} from 'lucide-react';

// Helper function for exponential backoff retry
const fetchWithRetry = async (url, options, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(res => setTimeout(res, delays[i]));
    }
  }
};

export default function App() {
  const [articleText, setArticleText] = useState("");
  const [activeTab, setActiveTab] = useState("editor");
  const [tone, setTone] = useState("professional");
  
  // API Key State (Loads from browser memory if exists)
  const [userApiKey, setUserApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [tempKeyInput, setTempKeyInput] = useState("");

  useEffect(() => {
    const savedKey = localStorage.getItem('reporter_api_key');
    if (savedKey) {
      setUserApiKey(savedKey);
      setTempKeyInput(savedKey);
    } else {
      setShowSettings(true); // Show settings on first load if no key
    }
  }, []);

  const saveApiKey = () => {
    localStorage.setItem('reporter_api_key', tempKeyInput.trim());
    setUserApiKey(tempKeyInput.trim());
    setShowSettings(false);
  };

  const removeApiKey = () => {
    localStorage.removeItem('reporter_api_key');
    setUserApiKey("");
    setTempKeyInput("");
  };

  // AI Results
  const [grammarResults, setGrammarResults] = useState(null);
  const [headlineResults, setHeadlineResults] = useState(null);
  const [summaryResults, setSummaryResults] = useState(null);
  const [seoResults, setSeoResults] = useState(null);
  
  const [loading, setLoading] = useState({ grammar: false, headlines: false, summary: false });
  const [error, setError] = useState(null);
  const [copiedId, setCopiedId] = useState("");

  // Common API Call Function using the User's Key
  const callGeminiAPI = async (systemPrompt, userText, schema, loadingKey) => {
    if (!userApiKey) {
      setShowSettings(true);
      setError("कृपया पहले अपनी API Key दर्ज करें। (Please enter your API Key first)");
      return null;
    }

    if (!userText.trim() || userText.length < 20) {
      setError("कृपया कम से कम 20 वर्णों का समाचार लेख दर्ज करें।");
      return null;
    }

    setLoading(prev => ({ ...prev, [loadingKey]: true }));
    setError(null);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${userApiKey}`;
    
    const payload = {
      contents: [{ parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    };

    try {
      const data = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!responseText) throw new Error("Invalid API Key or response");
      
      return JSON.parse(responseText);
    } catch (err) {
      console.error(err);
      setError("त्रुटि! कृपया सुनिश्चित करें कि आपकी API Key सही है। (Ensure your API Key is correct.)");
      setShowSettings(true);
      return null;
    } finally {
      setLoading(prev => ({ ...prev, [loadingKey]: false }));
    }
  };

  const processArticle = async () => {
    const toneInstructions = {
      professional: "Maintain a neutral, objective, and standard journalistic tone.",
      aggressive: "Use strong, bold language. Focus on the hard-hitting facts.",
      emotional: "Focus on the human element. Use words that evoke empathy."
    };
    const schema = { type: "OBJECT", properties: { correctedText: { type: "STRING" }, changes: { type: "ARRAY", items: { type: "STRING" } } } };
    const systemPrompt = `You are a Senior Editor at a Hindi News Agency. Correct grammar. Rewrite tone to: ${toneInstructions[tone]}. List changes made.`;
    const result = await callGeminiAPI(systemPrompt, articleText, schema, 'grammar');
    if (result) { setGrammarResults(result); setActiveTab("grammar"); }
  };

  const generateHeadlinesAndSEO = async () => {
    const schema = { type: "OBJECT", properties: { headlines: { type: "ARRAY", items: { type: "STRING" } }, keywords: { type: "ARRAY", items: { type: "STRING" } } } };
    const systemPrompt = "Suggest 5 non-clickbait Hindi news headlines. Provide 5 SEO keywords.";
    const result = await callGeminiAPI(systemPrompt, articleText, schema, 'headlines');
    if (result) { setHeadlineResults(result.headlines); setSeoResults(result.keywords); setActiveTab("headlines"); }
  };

  const generateSummary = async () => {
    const schema = { type: "OBJECT", properties: { shortSummary: { type: "STRING" }, bulletPoints: { type: "ARRAY", items: { type: "STRING" } } } };
    const systemPrompt = "Create a 2-sentence summary of this news. Provide 3 bullet points summarizing the article in Hindi.";
    const result = await callGeminiAPI(systemPrompt, articleText, schema, 'summary');
    if (result) { setSummaryResults(result); setActiveTab("summary"); }
  };

  const handleCopy = (text, id) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    setCopiedId(id);
    setTimeout(() => setCopiedId(""), 2000);
  };

  const clearAll = () => {
    setArticleText(""); setGrammarResults(null); setHeadlineResults(null); setSummaryResults(null); setSeoResults(null); setError(null); setActiveTab("editor");
  };

  const stats = { words: articleText.trim() ? articleText.trim().split(/\s+/).length : 0 };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans">
      
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-black flex items-center text-slate-800">
                <Key className="h-5 w-5 mr-2 text-orange-500" />
                API Key सेटिंग्स
              </h2>
              {userApiKey && (
                <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600">
                  <X className="h-6 w-6" />
                </button>
              )}
            </div>
            
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                इस टूल का उपयोग करने के लिए आपको अपनी स्वयं की Google Gemini API Key की आवश्यकता होगी। यह निःशुल्क है।
              </p>
              
              <ol className="text-xs text-slate-500 space-y-2 list-decimal list-inside bg-slate-50 p-4 rounded-lg border border-slate-100">
                <li><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-600 font-bold hover:underline">Google AI Studio</a> पर जाएं।</li>
                <li>"Create API Key" पर क्लिक करें।</li>
                <li>Key को कॉपी करें और नीचे पेस्ट करें।</li>
              </ol>

              <div>
                <input 
                  type="password" 
                  value={tempKeyInput}
                  onChange={(e) => setTempKeyInput(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-4 py-3 bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono text-sm"
                />
                <p className="text-[10px] text-slate-400 mt-2 flex items-center">
                  <Target className="h-3 w-3 mr-1" /> आपकी Key सुरक्षित रूप से केवल आपके ब्राउज़र में सेव होती है।
                </p>
              </div>

              <div className="flex space-x-3 pt-4">
                <button 
                  onClick={saveApiKey}
                  disabled={!tempKeyInput.trim()}
                  className="flex-1 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-300 text-white font-bold py-3 rounded-xl transition-all"
                >
                  सेव करें (Save)
                </button>
                {userApiKey && (
                  <button 
                    onClick={removeApiKey}
                    className="px-4 bg-red-50 hover:bg-red-100 text-red-600 font-bold py-3 rounded-xl transition-all border border-red-200"
                  >
                    हटाएं
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Top Navbar */}
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-orange-600 p-1.5 rounded-lg rotate-3 shadow-lg shadow-orange-100">
              <PenTool className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-black text-slate-800 tracking-tight">पत्रकार <span className="text-orange-600">AI</span></h1>
          </div>
          
          <div className="flex items-center space-x-3">
             <div className="hidden sm:flex items-center space-x-3 text-xs font-bold text-slate-400 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-100 mr-2">
                <span>{stats.words} शब्द</span>
             </div>
             {articleText.length > 0 && (
                <button onClick={clearAll} className="p-2 text-slate-400 hover:text-red-500 transition-colors" title="Clear All">
                  <RefreshCw className="h-5 w-5" />
                </button>
             )}
             <button 
               onClick={() => setShowSettings(true)} 
               className={`flex items-center space-x-2 px-3 py-2 rounded-lg font-bold text-sm transition-all border ${userApiKey ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' : 'bg-orange-50 text-orange-700 border-orange-200 animate-pulse'}`}
             >
               <Settings className="h-4 w-4" />
               <span className="hidden sm:inline">{userApiKey ? 'Key Active' : 'Add API Key'}</span>
             </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
        {error && (
          <div className="mb-6 bg-red-50 border-l-4 border-red-500 text-red-700 px-4 py-3 rounded-r-lg flex items-center shadow-sm">
            <AlertCircle className="h-5 w-5 mr-3 flex-shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Editor Side */}
          <div className={`lg:col-span-6 flex flex-col space-y-4 ${activeTab !== 'editor' && 'hidden lg:flex'}`}>
            <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 border border-slate-200 overflow-hidden flex flex-col h-[600px]">
              <div className="bg-white px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <FileText className="h-4 w-4 text-orange-500" />
                  <span className="text-sm font-bold text-slate-700 uppercase tracking-wider">न्यूज़ ड्राफ्ट</span>
                </div>
                <div className="flex bg-slate-100 p-1 rounded-lg">
                  {['professional', 'aggressive', 'emotional'].map(t => (
                    <button key={t} onClick={() => setTone(t)} className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${tone === t ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                      {t === 'professional' ? 'न्यूट्रल' : t === 'aggressive' ? 'आक्रामक' : 'भावुक'}
                    </button>
                  ))}
                </div>
              </div>
              
              <textarea
                value={articleText}
                onChange={(e) => setArticleText(e.target.value)}
                placeholder="अपनी खबर यहाँ लिखें या पेस्ट करें..."
                className="flex-1 p-6 resize-none focus:outline-none text-lg leading-relaxed text-slate-700 placeholder-slate-300 bg-transparent"
              />

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex flex-wrap gap-2">
                <button
                  onClick={processArticle}
                  disabled={loading.grammar}
                  className="flex-1 flex items-center justify-center space-x-2 bg-slate-900 hover:bg-black text-white py-3 px-4 rounded-xl font-bold transition-all disabled:opacity-50"
                >
                  {loading.grammar ? <Loader2 className="h-5 w-5 animate-spin" /> : <Zap className="h-5 w-5 text-orange-400" />}
                  <span>आर्टिकल एडिट करें</span>
                </button>
                
                <div className="flex gap-2 w-full sm:w-auto">
                  <button onClick={generateHeadlinesAndSEO} disabled={loading.headlines} className="flex-1 sm:flex-none p-3 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-700 flex justify-center">
                    {loading.headlines ? <Loader2 className="h-5 w-5 animate-spin" /> : <Type className="h-5 w-5" />}
                  </button>
                  <button onClick={generateSummary} disabled={loading.summary} className="flex-1 sm:flex-none p-3 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-700 flex justify-center">
                    {loading.summary ? <Loader2 className="h-5 w-5 animate-spin" /> : <Share2 className="h-5 w-5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Results Side */}
          <div className={`lg:col-span-6 space-y-6 ${activeTab === 'editor' && 'hidden lg:block'}`}>
            
            {/* Mobile Tab Switcher */}
            <div className="lg:hidden flex space-x-2 overflow-x-auto pb-4 scrollbar-hide">
              <button onClick={() => setActiveTab('editor')} className={`flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold uppercase ${activeTab === 'editor' ? 'bg-orange-600 text-white' : 'bg-white border border-slate-200 text-slate-400'}`}>एडिटर</button>
              {grammarResults && <button onClick={() => setActiveTab('grammar')} className={`flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold uppercase ${activeTab === 'grammar' ? 'bg-orange-600 text-white' : 'bg-white border border-slate-200 text-slate-400'}`}>संपादित लेख</button>}
              {headlineResults && <button onClick={() => setActiveTab('headlines')} className={`flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold uppercase ${activeTab === 'headlines' ? 'bg-orange-600 text-white' : 'bg-white border border-slate-200 text-slate-400'}`}>शीर्षक</button>}
              {summaryResults && <button onClick={() => setActiveTab('summary')} className={`flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold uppercase ${activeTab === 'summary' ? 'bg-orange-600 text-white' : 'bg-white border border-slate-200 text-slate-400'}`}>सारांश</button>}
            </div>

            {!grammarResults && !headlineResults && !summaryResults && !Object.values(loading).some(Boolean) && (
              <div className="h-[400px] flex flex-col items-center justify-center text-center p-8 bg-white rounded-2xl border-2 border-dashed border-slate-200 opacity-60">
                <div className="bg-slate-50 p-6 rounded-full mb-4">
                  <Target className="h-10 w-10 text-slate-300" />
                </div>
                <h3 className="text-xl font-bold text-slate-400">रिपोर्टिंग शुरू करें</h3>
                <p className="text-slate-400 max-w-xs mt-2 text-sm italic">
                  अपना लेख बाईं ओर लिखें।
                </p>
              </div>
            )}

            {/* AI Processed Content */}
            {(grammarResults || loading.grammar) && activeTab === 'grammar' && (
              <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
                <div className="bg-slate-900 px-6 py-4 flex justify-between items-center">
                  <div className="flex items-center space-x-2">
                    <History className="h-4 w-4 text-orange-400" />
                    <span className="text-sm font-bold text-white uppercase">संपादित लेख</span>
                  </div>
                  {grammarResults && (
                    <button onClick={() => handleCopy(grammarResults.correctedText, 'final')} className="bg-white/10 px-3 py-1 rounded-lg text-white text-xs font-bold">
                      {copiedId === 'final' ? 'कॉपीड' : 'कॉपी'}
                    </button>
                  )}
                </div>
                <div className="p-6">
                  {loading.grammar ? <Loader2 className="h-6 w-6 animate-spin text-slate-400" /> : (
                    <>
                      <div className="prose prose-slate max-w-none text-lg text-slate-800 leading-relaxed whitespace-pre-wrap border-l-4 border-orange-200 pl-4 py-2 bg-orange-50/20 rounded-r-lg">
                        {grammarResults.correctedText}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Headlines Tab */}
            {(headlineResults || loading.headlines) && activeTab === 'headlines' && (
              <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
                 <h3 className="text-sm font-black text-slate-400 uppercase mb-6 flex items-center">
                   <Type className="h-4 w-4 mr-2 text-indigo-500" /> शीर्षक सुझाव
                 </h3>
                 {loading.headlines ? <Loader2 className="h-6 w-6 animate-spin text-indigo-500" /> : (
                   <div className="space-y-3">
                     {headlineResults.map((h, i) => (
                       <div key={i} className="group relative flex items-center p-4 bg-slate-50 rounded-xl cursor-pointer" onClick={() => handleCopy(h, `h-${i}`)}>
                         <p className="flex-1 text-slate-800 font-bold">{h}</p>
                       </div>
                     ))}
                   </div>
                 )}
              </div>
            )}

            {/* Summary Tab */}
            {(summaryResults || loading.summary) && activeTab === 'summary' && (
              <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
                <div className="bg-purple-600 px-6 py-4 flex items-center space-x-2">
                  <Share2 className="h-4 w-4 text-white" />
                  <span className="text-sm font-bold text-white uppercase">सोशल मीडिया सारांश</span>
                </div>
                <div className="p-6">
                   {loading.summary ? <Loader2 className="h-6 w-6 animate-spin text-purple-500" /> : (
                     <div className="space-y-6">
                        <div className="bg-purple-50 p-5 rounded-2xl border border-purple-100">
                          <p className="text-slate-700 font-medium italic">"{summaryResults.shortSummary}"</p>
                        </div>
                     </div>
                   )}
                </div>
              </div>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}
