import React, { useState, useRef, useEffect } from 'react';
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
  Key,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

const apiKey = ""; // Provided by the execution environment

// Helper function for exponential backoff retry
const fetchWithRetry = async (url, options, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(res => setTimeout(res, delays[i]));
    }
  }
};

export default function App() {
  const [articleText, setArticleText] = useState("");
  const [activeTab, setActiveTab] = useState("editor"); // 'editor' on mobile, irrelevant on desktop
  
  // Custom API Key States
  const [userApiKey, setUserApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  
  // States for different AI tools
  const [grammarResults, setGrammarResults] = useState(null);
  const [headlineResults, setHeadlineResults] = useState(null);
  const [subHeadlineResults, setSubHeadlineResults] = useState(null);
  
  const [loading, setLoading] = useState({
    grammar: false,
    headlines: false,
    subHeadlines: false
  });
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Common API Call Function using Gemini structured JSON output
  const callGeminiAPI = async (systemPrompt, userText, schema, loadingKey) => {
    if (!userText.trim()) {
      setError("कृपया पहले समाचार का लेख दर्ज करें। (Please enter the news article first.)");
      return null;
    }

    setLoading(prev => ({ ...prev, [loadingKey]: true }));
    setError(null);

    // Use the user-provided API key, or fallback to the environment's injected key
    const activeKey = userApiKey.trim() || apiKey;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${activeKey}`;
    
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
      if (!responseText) throw new Error("Invalid response from API");
      
      return JSON.parse(responseText);
    } catch (err) {
      console.error(err);
      setError("क्षमा करें, सर्वर से संपर्क करने में त्रुटि हुई। कृपया सुनिश्चित करें कि आपकी API Key सही है। (Error connecting. Please ensure your API Key is correct.)");
      return null;
    } finally {
      setLoading(prev => ({ ...prev, [loadingKey]: false }));
    }
  };

  // 1. Check Grammar & Spelling
  const checkGrammar = async () => {
    const schema = {
      type: "OBJECT",
      properties: {
        correctedText: { 
          type: "STRING", 
          description: "The fully corrected, professional Hindi news article." 
        },
        errorList: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "A bulleted list in Hindi explaining the grammatical or spelling mistakes found in the original text."
        }
      }
    };
    
    const systemPrompt = "You are an expert Hindi newspaper editor. Your job is to review the provided Hindi news article. Fix any grammatical errors, spelling mistakes, punctuation issues, and awkward phrasing. Make the tone professional and journalistic. Provide the fully corrected text and a list of specific errors you found and fixed.";
    
    const result = await callGeminiAPI(systemPrompt, articleText, schema, 'grammar');
    if (result) {
      setGrammarResults(result);
      setActiveTab("grammar");
    }
  };

  // 2. Suggest Headlines
  const suggestHeadlines = async () => {
    const schema = {
      type: "OBJECT",
      properties: {
        suggestions: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "List of 5 catchy, professional Hindi newspaper headlines."
        }
      }
    };

    const systemPrompt = "You are an expert Hindi newspaper editor. Read the provided news article and suggest 5 catchy, engaging, and professional headlines in Hindi. Ensure they are concise and capture the essence of the news.";

    const result = await callGeminiAPI(systemPrompt, articleText, schema, 'headlines');
    if (result) {
      setHeadlineResults(result.suggestions);
      setActiveTab("headlines");
    }
  };

  // 3. Suggest Sub-Headlines
  const suggestSubHeadlines = async () => {
    const schema = {
      type: "OBJECT",
      properties: {
        suggestions: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "List of 3 to 5 logical sub-headlines in Hindi."
        }
      }
    };

    const systemPrompt = "You are an expert Hindi newspaper editor. Read the provided news article and suggest 3 to 5 sub-headlines (उप-शीर्षक) in Hindi that break down the key points of the article and can be used to divide the content for better readability.";

    const result = await callGeminiAPI(systemPrompt, articleText, schema, 'subHeadlines');
    if (result) {
      setSubHeadlineResults(result.suggestions);
      setActiveTab("subHeadlines");
    }
  };

  const handleCopy = (text) => {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text', err);
    }
  };

  const clearAll = () => {
    if(window.confirm("क्या आप वाकई सब कुछ मिटाना चाहते हैं? (Are you sure you want to clear everything?)")) {
      setArticleText("");
      setGrammarResults(null);
      setHeadlineResults(null);
      setSubHeadlineResults(null);
      setError(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-200 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <PenTool className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800 leading-tight">पत्रकार AI <span className="text-sm font-normal text-slate-500 hidden sm:inline-block ml-2">| Hindi Reporter Assistant</span></h1>
            </div>
          </div>
          
          <div className="flex items-center space-x-4">
            {articleText.length > 0 && (
               <button 
                 onClick={clearAll}
                 className="text-sm flex items-center space-x-1 text-slate-500 hover:text-red-600 transition-colors"
               >
                 <RefreshCw className="h-4 w-4" />
                 <span className="hidden sm:inline">नया लेख (New)</span>
               </button>
            )}
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${showSettings || userApiKey ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-transparent'}`}
            >
              <Key className="h-4 w-4" />
              <span className="hidden sm:inline">API Key</span>
              {showSettings ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      {/* API Key Settings Panel */}
      {showSettings && (
        <div className="bg-slate-800 text-white border-b border-slate-700 px-4 py-4 shadow-inner">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center space-x-2">
              <Key className="h-5 w-5 text-blue-400" />
              <span className="font-medium">Your Gemini API Key:</span>
            </div>
            <div className="flex-1 w-full max-w-2xl">
              <input
                type="password"
                value={userApiKey}
                onChange={(e) => setUserApiKey(e.target.value)}
                placeholder="Enter key to run locally (Starts with AIza...)"
                className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div className="text-sm text-slate-400 sm:w-1/4">
              {userApiKey ? (
                <span className="text-green-400 flex items-center"><CheckCircle className="h-4 w-4 mr-1" /> Custom Key Active</span>
              ) : (
                "Leave empty to use Gemini Platform's default key."
              )}
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col">
        
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-start shadow-sm">
            <AlertCircle className="h-5 w-5 mr-3 mt-0.5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
          
          {/* Left Column: Editor */}
          <div className={`lg:w-1/2 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden ${activeTab !== 'editor' && 'hidden lg:flex'}`}>
            <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex justify-between items-center">
              <h2 className="font-semibold text-slate-700 flex items-center">
                <FileText className="h-4 w-4 mr-2 text-blue-600" />
                अपना समाचार यहाँ लिखें (Draft Your News)
              </h2>
              <span className="text-xs text-slate-400 font-mono">
                {articleText.length} वर्ण (chars)
              </span>
            </div>
            
            <textarea
              value={articleText}
              onChange={(e) => setArticleText(e.target.value)}
              placeholder="यहाँ से टाइप करना शुरू करें..."
              className="flex-1 w-full p-6 resize-none focus:outline-none text-lg leading-relaxed text-slate-700 placeholder-slate-300 h-64 lg:h-auto"
              spellCheck="false"
            />

            {/* Action Bar */}
            <div className="bg-slate-50 border-t border-slate-200 p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                onClick={checkGrammar}
                disabled={loading.grammar}
                className="flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-70 shadow-sm"
              >
                {loading.grammar ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                <span>व्याकरण जांचें</span>
              </button>
              
              <button
                onClick={suggestHeadlines}
                disabled={loading.headlines}
                className="flex items-center justify-center space-x-2 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-70 shadow-sm"
              >
                {loading.headlines ? <Loader2 className="h-4 w-4 animate-spin" /> : <Type className="h-4 w-4" />}
                <span>शीर्षक सुझाएं</span>
              </button>

              <button
                onClick={suggestSubHeadlines}
                disabled={loading.subHeadlines}
                className="flex items-center justify-center space-x-2 bg-purple-600 hover:bg-purple-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-70 shadow-sm"
              >
                {loading.subHeadlines ? <Loader2 className="h-4 w-4 animate-spin" /> : <LayoutTemplate className="h-4 w-4" />}
                <span>उप-शीर्षक सुझाएं</span>
              </button>
            </div>
          </div>

          {/* Mobile Tab Switcher */}
          <div className="lg:hidden flex space-x-2 mb-4 overflow-x-auto pb-2">
            <button onClick={() => setActiveTab('editor')} className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium ${activeTab === 'editor' ? 'bg-blue-100 text-blue-700' : 'bg-white text-slate-600 border border-slate-200'}`}>संपादक (Editor)</button>
            {grammarResults && <button onClick={() => setActiveTab('grammar')} className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium ${activeTab === 'grammar' ? 'bg-blue-100 text-blue-700' : 'bg-white text-slate-600 border border-slate-200'}`}>व्याकरण (Grammar)</button>}
            {headlineResults && <button onClick={() => setActiveTab('headlines')} className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium ${activeTab === 'headlines' ? 'bg-blue-100 text-blue-700' : 'bg-white text-slate-600 border border-slate-200'}`}>शीर्षक (Headlines)</button>}
            {subHeadlineResults && <button onClick={() => setActiveTab('subHeadlines')} className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium ${activeTab === 'subHeadlines' ? 'bg-blue-100 text-blue-700' : 'bg-white text-slate-600 border border-slate-200'}`}>उप-शीर्षक (Sub-headlines)</button>}
          </div>

          {/* Right Column: Results */}
          <div className={`lg:w-1/2 flex flex-col space-y-6 overflow-y-auto pr-2 pb-10 ${activeTab === 'editor' && 'hidden lg:flex'}`}>
            
            {/* Empty State */}
            {!grammarResults && !headlineResults && !subHeadlineResults && !Object.values(loading).some(Boolean) && (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-slate-100/50 rounded-xl border border-dashed border-slate-300 h-64 lg:h-auto">
                <div className="bg-white p-4 rounded-full shadow-sm mb-4">
                  <PenTool className="h-8 w-8 text-slate-300" />
                </div>
                <h3 className="text-lg font-medium text-slate-700 mb-2">AI सहायक तैयार है</h3>
                <p className="text-slate-500 max-w-sm">
                  अपना समाचार बाईं ओर लिखें और व्याकरण जांचने या शीर्षक सुझाव प्राप्त करने के लिए नीचे दिए गए बटन पर क्लिक करें।
                </p>
              </div>
            )}

            {/* Grammar Results */}
            {(grammarResults || loading.grammar) && (
              <div className={`bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden ${activeTab !== 'grammar' && 'hidden lg:block'}`}>
                 <div className="bg-blue-50 border-b border-blue-100 px-5 py-3 flex justify-between items-center">
                    <h3 className="font-semibold text-blue-800 flex items-center">
                      <CheckCircle className="h-5 w-5 mr-2" /> 
                      सुधरा हुआ लेख (Corrected Article)
                    </h3>
                    {grammarResults && (
                      <button onClick={() => handleCopy(grammarResults.correctedText)} className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100 transition-colors">
                        {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
                      </button>
                    )}
                 </div>
                 <div className="p-5">
                    {loading.grammar ? (
                      <div className="flex items-center space-x-3 text-slate-500 animate-pulse">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span>लेख की समीक्षा की जा रही है...</span>
                      </div>
                    ) : (
                      <>
                        <div className="prose prose-slate max-w-none text-lg text-slate-700 leading-relaxed mb-6 whitespace-pre-wrap">
                          {grammarResults.correctedText}
                        </div>
                        
                        {grammarResults.errorList && grammarResults.errorList.length > 0 && (
                          <div className="mt-6 pt-5 border-t border-slate-100">
                            <h4 className="text-sm font-bold text-red-600 mb-3 uppercase tracking-wider">पाई गई त्रुटियां (Errors Found):</h4>
                            <ul className="space-y-2">
                              {grammarResults.errorList.map((error, idx) => (
                                <li key={idx} className="flex items-start text-sm text-slate-600 bg-red-50 p-2 rounded">
                                  <span className="text-red-400 mr-2">•</span>
                                  <span>{error}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                 </div>
              </div>
            )}

            {/* Headlines Results */}
            {(headlineResults || loading.headlines) && (
              <div className={`bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden ${activeTab !== 'headlines' && 'hidden lg:block'}`}>
                 <div className="bg-indigo-50 border-b border-indigo-100 px-5 py-3">
                    <h3 className="font-semibold text-indigo-800 flex items-center">
                      <Type className="h-5 w-5 mr-2" /> 
                      सुझाए गए शीर्षक (Suggested Headlines)
                    </h3>
                 </div>
                 <div className="p-5">
                    {loading.headlines ? (
                      <div className="flex items-center space-x-3 text-slate-500 animate-pulse">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span>शीर्षक तैयार किए जा रहे हैं...</span>
                      </div>
                    ) : (
                      <ul className="space-y-3">
                        {headlineResults.map((headline, idx) => (
                          <li key={idx} className="group relative flex items-center p-3 rounded-lg border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/50 transition-all">
                            <span className="font-bold text-indigo-300 mr-4 text-xl">{idx + 1}</span>
                            <span className="text-lg text-slate-800 font-medium flex-1">{headline}</span>
                            <button 
                              onClick={() => handleCopy(headline)}
                              className="opacity-0 group-hover:opacity-100 p-2 text-indigo-500 hover:bg-indigo-100 rounded-md transition-all absolute right-2"
                              title="Copy headline"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                 </div>
              </div>
            )}

            {/* Sub-Headlines Results */}
            {(subHeadlineResults || loading.subHeadlines) && (
              <div className={`bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden ${activeTab !== 'subHeadlines' && 'hidden lg:block'}`}>
                 <div className="bg-purple-50 border-b border-purple-100 px-5 py-3">
                    <h3 className="font-semibold text-purple-800 flex items-center">
                      <LayoutTemplate className="h-5 w-5 mr-2" /> 
                      सुझाए गए उप-शीर्षक (Suggested Sub-headlines)
                    </h3>
                 </div>
                 <div className="p-5">
                    {loading.subHeadlines ? (
                      <div className="flex items-center space-x-3 text-slate-500 animate-pulse">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span>उप-शीर्षक तैयार किए जा रहे हैं...</span>
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        {subHeadlineResults.map((subHeadline, idx) => (
                          <div key={idx} className="flex justify-between items-center p-3 rounded-lg bg-slate-50 border border-slate-100 group">
                            <span className="text-slate-700 font-medium">{subHeadline}</span>
                            <button 
                              onClick={() => handleCopy(subHeadline)}
                              className="opacity-0 group-hover:opacity-100 p-1.5 text-purple-500 hover:bg-purple-100 rounded-md transition-all"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
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