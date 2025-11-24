import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Lightbulb, CheckCircle, Edit, Loader2, RefreshCw, Send, Maximize, Minimize } from 'lucide-react';

// --- Firebase and Gemini API Setup ---
// The API Key will be automatically handled by the environment if left as an empty string.
const apiKey = ""; 
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// The specific JSON structure we expect from the API
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    processedTextHtml: {
      type: "STRING",
      description: "The original text with all errors wrapped in <span class='text-red-600 font-semibold cursor-pointer' data-error-id='X'>...</span> where X is a unique number."
    },
    suggestedImprovements: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          errorId: { type: "NUMBER", description: "The unique ID (X) matching the data-error-id in processedTextHtml." },
          original: { type: "STRING", description: "The original incorrect word or phrase." },
          correction: { type: "STRING", description: "The suggested correction/improvement." }
        },
        propertyOrdering: ["errorId", "original", "correction"]
      }
    },
    headlines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          headline: { type: "STRING", description: "A catchy news headline in Hindi." },
          subheadline: { type: "STRING", description: "A summarizing subheadline in Hindi." }
        },
        propertyOrdering: ["headline", "subheadline"]
      }
    }
  },
  propertyOrdering: ["processedTextHtml", "suggestedImprovements", "headlines"]
};


// --- Helper Functions ---

const exponentialBackoffFetch = async (url, options, maxRetries = 5) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 429) { // Not a rate limit error
        return response;
      }
      // Log for debugging (but not in production console)
      // console.warn(`Rate limit hit. Retrying in ${2 ** attempt}s...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    } catch (error) {
      // console.error(`Fetch attempt ${attempt + 1} failed:`, error);
      if (attempt === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error("API call failed after multiple retries.");
};


// --- Main Component ---

const App = () => {
  const [inputText, setInputText] = useState('');
  const [analyzedContent, setAnalyzedContent] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [headlineCount, setHeadlineCount] = useState(10);
  const [selectedError, setSelectedError] = useState(null); // The error object being viewed
  const [isFullScreen, setIsFullScreen] = useState(false);

  // Set the default error suggestion to the first one available
  useEffect(() => {
    if (analyzedContent && analyzedContent.suggestedImprovements.length > 0) {
      setSelectedError(analyzedContent.suggestedImprovements[0]);
    } else {
      setSelectedError(null);
    }
  }, [analyzedContent]);

  // Handler for clicking on a highlighted error in the text box
  const handleErrorClick = useCallback((event) => {
    const target = event.target;
    if (target.classList.contains('cursor-pointer') && target.dataset.errorId) {
      const errorId = parseInt(target.dataset.errorId, 10);
      const error = analyzedContent.suggestedImprovements.find(imp => imp.errorId === errorId);
      if (error) {
        setSelectedError(error);
      }
    }
  }, [analyzedContent]);

  // Main function to call the Gemini API
  const handleTextAnalysis = useCallback(async (refreshHeadlines = false) => {
    if (!inputText.trim()) {
      alert("Please paste the article text or upload an image first.");
      return;
    }

    setIsLoading(true);
    let tempContent = analyzedContent;
    
    // If we're just refreshing headlines, keep existing processed text and suggestions
    if (refreshHeadlines && analyzedContent) {
      tempContent = {
        ...analyzedContent,
        headlines: [] // Clear headlines to refresh
      };
      setAnalyzedContent(tempContent); // Update UI to show loading for headlines only
    } else {
        setAnalyzedContent(null);
        tempContent = null;
    }

    // Determine the user query and system prompt based on whether we are refreshing
    const userQuery = `Analyze the following news article text. ${tempContent ? 'ONLY generate new headlines.' : 'Detect and highlight grammatical, spelling, and stylistic errors. Highlight errors using the HTML tag <span class="text-red-600 font-semibold cursor-pointer" data-error-id="X">...</span> where X is a unique number (starting from 1) for each error. I need to know the original error word/phrase, its corresponding correction, and also generate a list of'} ${headlineCount} headline and subheadline pairs in Hindi, prioritizing high-impact journalistic tone. ${tempContent ? 'The text for analysis is the same as before.' : 'The text is:'}\n\n${inputText}`;

    const systemInstruction = {
        parts: [{ text: "You are a world-class professional news editor and language specialist. Your task is to analyze the provided article text, detect errors, and generate compelling, high-impact headlines and subheadlines in Hindi based on the article's content. Output must be a single, strictly valid JSON object adhering to the provided schema. Do not include any introductory or concluding text outside the JSON." }]
    };

    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      },
      systemInstruction: systemInstruction,
    };

    try {
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };

      const response = await exponentialBackoffFetch(GEMINI_API_URL, options);
      const result = await response.json();
      
      const jsonString = result?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!jsonString) {
        throw new Error("API response was empty or malformed.");
      }

      const parsedJson = JSON.parse(jsonString);

      if (refreshHeadlines && tempContent) {
        // Only update the headlines array
        setAnalyzedContent(prev => ({
          ...prev,
          headlines: parsedJson.headlines
        }));
      } else {
        // Full update
        setAnalyzedContent(parsedJson);
      }
      
    } catch (error) {
      console.error("Error during Gemini API call:", error);
      alert("Failed to analyze text. Please check the console for details.");
    } finally {
      setIsLoading(false);
    }
  }, [inputText, headlineCount, analyzedContent]);


  // Placeholder for OCR/Image Upload functionality
  const handleImageUpload = () => {
    alert("Image upload and OCR functionality is a planned feature. For now, please paste the text directly into the box.");
  };
  
  // Toggle full screen mode for better typing experience
  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
  };

  const appContainerClasses = isFullScreen 
    ? "fixed inset-0 z-50 p-4 bg-gray-50 overflow-auto transition-all duration-300"
    : "max-w-7xl mx-auto p-4 transition-all duration-300";

  return (
    <div className={appContainerClasses}>
      <h1 className="text-3xl font-extrabold text-blue-800 mb-6 border-b-2 pb-2">
        <Edit className="inline-block mr-2 h-7 w-7"/> Reporter's Editorial Assistant
      </h1>
      <p className="text-gray-600 mb-6">
        Paste your article or select a file to detect errors, get suggestions, and generate compelling Hindi headlines.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* --- LEFT COLUMN: Input and Error Detection --- */}
        <div className={`col-span-1 lg:col-span-2 ${isFullScreen ? 'h-full flex flex-col' : ''}`}>
          <div className="mb-6 bg-white p-6 rounded-xl shadow-lg border border-gray-200 flex-1">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold text-gray-700 flex items-center">
                  <Maximize className="mr-2 h-5 w-5 text-blue-500" onClick={toggleFullScreen} />
                  Article Input & Analysis
                </h2>
                <button
                    onClick={toggleFullScreen}
                    className="p-2 text-sm text-gray-500 hover:text-blue-500 transition-colors"
                    aria-label={isFullScreen ? "Exit full screen" : "Enter full screen"}
                >
                    {isFullScreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
                </button>
            </div>
            
            {/* Input Text Area */}
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Paste your news article text here..."
              rows={isFullScreen ? 20 : 10}
              className={`w-full p-3 mb-4 border-2 border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 transition-shadow resize-none ${isFullScreen ? 'flex-1' : ''}`}
            />
            
            {/* Action Buttons */}
            <div className="flex gap-4">
              <button
                onClick={() => handleTextAnalysis(false)}
                disabled={isLoading}
                className="flex items-center justify-center px-6 py-2 bg-blue-600 text-white font-medium rounded-lg shadow-md hover:bg-blue-700 transition-colors disabled:bg-blue-300"
              >
                {isLoading && !analyzedContent ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Send className="mr-2 h-5 w-5" />}
                {isLoading && !analyzedContent ? 'Analyzing...' : 'Analyze Text'}
              </button>
              <button
                onClick={handleImageUpload}
                className="flex items-center justify-center px-6 py-2 border border-blue-600 text-blue-600 font-medium rounded-lg shadow-md hover:bg-blue-50 transition-colors"
              >
                Upload Image (OCR)
              </button>
            </div>

            {/* Error Detection Box (Output 1) */}
            <div className="mt-8">
              <h3 className="text-lg font-semibold text-gray-700 mb-3 flex items-center">
                <CheckCircle className="mr-2 h-5 w-5 text-green-500" /> Error-Checked Text (Click Red Text for Suggestions)
              </h3>
              <div 
                className="min-h-[150px] p-4 bg-gray-50 border border-red-300 rounded-lg text-gray-800 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: analyzedContent?.processedTextHtml || 'Analysis results will appear here. Errors will be highlighted in red.' }}
                onClick={handleErrorClick}
              />
            </div>
          </div>
        </div>

        {/* --- RIGHT COLUMN: Suggestions and Headlines --- */}
        <div className="col-span-1">
            
          {/* Suggested Improvement Box (Output 2) */}
          <div className="mb-6 bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <h2 className="text-xl font-semibold text-gray-700 mb-3 flex items-center">
              <Lightbulb className="mr-2 h-5 w-5 text-yellow-500" /> Suggested Improvement
            </h2>
            <div className='min-h-[100px]'>
              {selectedError ? (
                <div className='space-y-3'>
                  <p className="text-sm text-gray-600 font-medium">Original Error:</p>
                  <p className="p-2 bg-red-100 text-red-800 rounded-md font-mono">{selectedError.original}</p>
                  <p className="text-sm text-gray-600 font-medium">Suggested Correction:</p>
                  <p className="p-2 bg-green-100 text-green-800 rounded-md font-mono">{selectedError.correction}</p>
                  <p className="text-xs text-gray-500 mt-2">
                    Click on any other highlighted red word in the text box to see its suggestion here.
                  </p>
                </div>
              ) : (
                <p className='text-gray-500 italic'>Click on a highlighted error in the text box after analysis to see the correction here.</p>
              )}
            </div>
          </div>

          {/* Headline Generation Box (Output 3) */}
          <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <h2 className="text-xl font-semibold text-gray-700 mb-3 flex items-center">
              <Lightbulb className="mr-2 h-5 w-5 text-purple-500" /> Hindi Headlines & Subheadlines
            </h2>
            
            {/* Headline Count Selector and Refresh Button */}
            <div className="flex justify-between items-center mb-4">
              <label htmlFor="headline-count" className="text-sm text-gray-600">
                Number of Headlines (5-25):
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="headline-count"
                  value={headlineCount}
                  onChange={(e) => setHeadlineCount(parseInt(e.target.value))}
                  className="p-1 border border-gray-300 rounded-md text-sm"
                  disabled={isLoading}
                >
                  {Array.from({ length: 21 }, (_, i) => i + 5).map(num => (
                    <option key={num} value={num}>{num}</option>
                  ))}
                </select>
                <button
                  onClick={() => handleTextAnalysis(true)}
                  disabled={isLoading || !analyzedContent}
                  className="p-2 bg-purple-100 text-purple-600 rounded-full hover:bg-purple-200 transition-colors disabled:opacity-50"
                  title="Refresh Headlines"
                >
                  <RefreshCw className={`h-4 w-4 ${isLoading && analyzedContent ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {/* Headlines List */}
            <div className="max-h-96 overflow-y-auto space-y-4">
              {isLoading && analyzedContent ? (
                <div className="flex justify-center items-center h-20">
                    <Loader2 className="h-8 w-8 text-purple-500 animate-spin" />
                </div>
              ) : (analyzedContent?.headlines?.length > 0 ? (
                analyzedContent.headlines.map((item, index) => (
                  <div key={index} className="border-l-4 border-purple-500 pl-3 py-1 bg-purple-50 rounded-r-md shadow-sm">
                    <p className="font-bold text-base text-purple-800">
                      {index + 1}. {item.headline}
                    </p>
                    <p className="text-sm text-purple-600 italic mt-0.5">
                      {item.subheadline}
                    </p>
                  </div>
                ))
              ) : (
                <p className='text-gray-500 italic'>Headlines will appear here after analysis.</p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
