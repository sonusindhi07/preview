import React, { useState, useCallback, useMemo, useEffect } from 'react';

// --- Google Identity Services Configuration ---
// IMPORTANT: You MUST replace this placeholder with your actual Google OAuth 2.0 Client ID.
// This ID is publicly visible and is not sensitive.
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID_HERE"; 

// Scope required to authorize access to Google's AI services
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Base API URL (no key is needed, as authorization is done via the header)
const geminiApiBaseUrl = (model) => 
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// --- Utility Functions ---

/**
 * Converts a file (like an image) into a Base64 string for multimodal API calls.
 * @param {File} file - The image file object.
 * @returns {Promise<string>} Base64 encoded string.
 */
const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64String = reader.result.split(',')[1];
            resolve(base64String);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

/**
 * Performs exponential backoff for API calls.
 * @param {Function} apiCall - The function that performs the fetch request.
 * @param {number} maxRetries - Maximum number of retries.
 * @returns {Promise<Object>} The final JSON response object.
 */
const withExponentialBackoff = async (apiCall, maxRetries = 5) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await apiCall();
            if (!response.ok) {
                // If the error is 429 (Rate Limit), we will retry.
                if (response.status === 429 && attempt < maxRetries - 1) {
                    throw new Error(`Rate limit hit, retrying... (Attempt ${attempt + 1})`);
                }
                // Handle 401 Unauthorized errors specifically for clearer user feedback
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authorization failed: Please re-login with your Google Account. Check that the required API scopes are granted.`);
                }
                throw new Error(`API error: ${response.statusText} (${response.status})`);
            }
            return await response.json();
        } catch (error) {
            console.warn(error.message);
            if (attempt === maxRetries - 1) {
                throw new Error("Failed to connect to the AI service after multiple retries.");
            }
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};


// --- Component Definition ---

const App = () => {
    // --- Authentication State ---
    const [accessToken, setAccessToken] = useState(null);
    const [userProfile, setUserProfile] = useState(null);
    const [authError, setAuthError] = useState(null);

    // --- App State ---
    const [inputText, setInputText] = useState('');
    const [selectedImage, setSelectedImage] = useState(null);
    const [processing, setProcessing] = useState(false);
    const [analysisResult, setAnalysisResult] = useState(null);
    const [error, setError] = useState(null);
    const [headlineCount, setHeadlineCount] = useState(5);

    const isLoggedIn = !!accessToken;
    const model = 'gemini-2.5-flash-preview-09-2025';


    // --- Google Identity Services Initialization ---
    useEffect(() => {
        if (typeof window.google === 'undefined' && GOOGLE_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE") {
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            document.head.appendChild(script);

            script.onload = () => {
                try {
                    // 1. Initialize the Token Client
                    const client = window.google.accounts.oauth2.initTokenClient({
                        client_id: GOOGLE_CLIENT_ID,
                        scope: GOOGLE_SCOPE,
                        callback: (tokenResponse) => {
                            if (tokenResponse && tokenResponse.access_token) {
                                setAccessToken(tokenResponse.access_token);
                                setAuthError(null);
                                
                                // Get basic user profile info using the access token
                                fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                                    headers: {
                                        Authorization: `Bearer ${tokenResponse.access_token}`,
                                    },
                                })
                                .then(res => res.json())
                                .then(data => setUserProfile(data))
                                .catch(err => console.error("Failed to fetch user profile:", err));

                            } else {
                                setAccessToken(null);
                                setAuthError("Failed to retrieve access token.");
                            }
                        },
                        error_callback: (error) => {
                            setAuthError(`Authentication error: ${error.type}. Check console for details.`);
                            console.error("GIS Error:", error);
                        }
                    });

                    // 2. Attach the listener to the login button
                    const loginButton = document.getElementById('google-login-button');
                    if (loginButton) {
                        loginButton.onclick = () => {
                            client.requestAccessToken();
                        };
                    }

                } catch (e) {
                    setAuthError(`Initialization failed. Did you replace GOOGLE_CLIENT_ID? Error: ${e.message}`);
                    console.error("GIS Initialization Error:", e);
                }
            };
        } else if (GOOGLE_CLIENT_ID === "YOUR_GOOGLE_CLIENT_ID_HERE") {
             setAuthError("CRITICAL: Please replace GOOGLE_CLIENT_ID with your own OAuth Client ID to enable user login.");
        }
    }, []);
    
    // Logout function
    const handleLogout = () => {
        setAccessToken(null);
        setUserProfile(null);
        // Revoking the token requires an extra API call which is complicated 
        // for a single-file React component, so we just clear local state.
    };

    // Function to handle text input changes
    const handleTextChange = (e) => {
        setInputText(e.target.value);
        setSelectedImage(null);
        setAnalysisResult(null);
    };

    // Function to handle image file selection
    const handleImageChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setSelectedImage(file);
            setInputText('');
            setAnalysisResult(null);
        }
    };

    // System instruction defining the AI's persona and task
    const systemInstruction = useMemo(() => `
        You are a world-class, meticulous copy editor, fact-checker, and headline strategist for a major metropolitan newspaper.
        Your task is to analyze the user-provided text (which may be transcribed from an image, or directly pasted), identify errors (grammar, spelling, style, clarity, conciseness), and generate a specific number of high-quality, compelling headlines and subheadlines.

        **CRITICAL INSTRUCTION**: You MUST respond ONLY with a single JSON object. DO NOT include any explanatory text, comments, or markdown outside the JSON block.

        The JSON must adhere to the following schema:
        1. "errors": An array of objects. For each error found, provide the exact 'original_phrase' that needs correction, the 'suggestion' for improvement, and the 'error_type'. If the text is perfect, provide an empty array: [].
        2. "headlines": An array of exactly ${headlineCount} objects. Each object must have a 'headline' (a catchy title) and a 'subheadline' (a descriptive, short summary).
    `, [headlineCount]);

    // --- Highlighting Logic (Remains the same) ---
    const highlightedContent = useMemo(() => {
        if (!analysisResult || !analysisResult.errors || !inputText) {
            return inputText;
        }

        let tempText = inputText;
        const errorPhrases = analysisResult.errors.map(e => e.original_phrase);

        errorPhrases.sort((a, b) => b.length - a.length);

        errorPhrases.forEach((phrase, index) => {
            if (!phrase) return;

            const escapedPhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const marker = `~~~ERROR_START_${index}~~~${phrase}~~~ERROR_END_${index}~~~`;
            
            const regex = new RegExp(escapedPhrase, 'i');
            
            tempText = tempText.replace(regex, marker);
        });

        const parts = tempText.split(/~~~ERROR_START_(\d+)~~~|~~~ERROR_END_(\d+)~~~/g).filter(Boolean);
        
        return parts.map((part, index) => {
            const errorIndexMatch = part.match(/~~~ERROR_START_(\d+)~~~(.*)/);
            if (errorIndexMatch) {
                const originalText = errorIndexMatch[2];
                return (
                    <span 
                        key={index} 
                        title={`Suggestion: ${analysisResult.errors[parseInt(errorIndexMatch[1])].suggestion}`}
                        className="bg-red-200 text-red-800 border-b-2 border-red-500 cursor-help font-semibold rounded px-0.5 transition-all duration-300 hover:bg-red-300"
                    >
                        {originalText}
                    </span>
                );
            } else if (part.startsWith('~~~ERROR_END_')) {
                return null;
            }
            return part;
        });

    }, [inputText, analysisResult]);


    // --- Core API Call Function ---
    const runAnalysis = useCallback(async (promptText, imageFile = null) => {
        if (!accessToken) {
            setError("Authentication Required: Please log in with your Google Account.");
            return;
        }

        setError(null);
        setProcessing(true);
        setAnalysisResult(null);

        try {
            let parts = [{ text: promptText }];
            
            // 1. Handle Image Input (OCR/Multimodal)
            if (imageFile) {
                const base64Data = await fileToBase64(imageFile);
                
                parts.unshift({
                    inlineData: {
                        mimeType: imageFile.type,
                        data: base64Data
                    }
                });
                
                parts[0].text = "Transcribe the full text from this image and then perform a copy editing and headline analysis on the transcribed text. The analysis output MUST be a single JSON object as described in the system instruction.";
            }

            // 2. Prepare Payload
            const payload = {
                contents: [{ role: "user", parts }],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            errors: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        original_phrase: { "type": "STRING", description: "The exact phrase or sentence with the error." },
                                        suggestion: { "type": "STRING", description: "The corrected or improved text." },
                                        error_type: { "type": "STRING", description: "Type of error (e.g., Grammar, Spelling, Style, Clarity)." }
                                    }
                                }
                            },
                            headlines: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        headline: { "type": "STRING", description: "A compelling headline." },
                                        subheadline: { "type": "STRING", description: "A concise subheadline/summary." }
                                    }
                                }
                            }
                        }
                    }
                },
                systemInstruction: { parts: [{ text: systemInstruction }] },
            };

            // 3. API Call with Authorization Header
            const jsonResponse = await withExponentialBackoff(() => fetch(geminiApiBaseUrl(model), {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}` // SECURE HEADER
                },
                body: JSON.stringify(payload)
            }));
            
            // 4. Process Response (same logic as before)
            let jsonText = jsonResponse.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!jsonText) {
                throw new Error("AI returned an empty or malformed response.");
            }

            let parsedJson;
            try {
                parsedJson = JSON.parse(jsonText);
            } catch (e) {
                console.warn("Raw JSON parsing failed. Attempting to strip markdown wrapper.");
                const cleanedText = jsonText.replace(/^\s*```json\s*|^\s*```\s*|\s*```\s*$/g, '');
                
                try {
                    parsedJson = JSON.parse(cleanedText);
                } catch (e2) {
                    console.error("Markdown-stripped JSON parsing also failed.", e2);
                    throw new Error("Failed to parse AI response into valid JSON after cleaning.");
                }
            }
            
            setAnalysisResult(parsedJson);

            // If it was an image, we need to show the transcribed text
            if (imageFile) {
                const fullText = await getFullTranscribedText(promptText, imageFile);
                if (fullText) {
                    setInputText(fullText);
                }
            }


        } catch (err) {
            console.error("Analysis Error:", err);
            setError(err.message || "An unknown error occurred during analysis.");
        } finally {
            setProcessing(false);
        }
    }, [headlineCount, systemInstruction, accessToken]);
    
    // Function to get the full transcribed text for image inputs
    const getFullTranscribedText = useCallback(async (initialPrompt, imageFile) => {
        if (!imageFile || !accessToken) return null;

        try {
            const base64Data = await fileToBase64(imageFile);
            const transcriptionPrompt = "Transcribe the entire text from this image exactly as it appears. Do not analyze or modify it. Return ONLY the transcribed text.";

            const payload = {
                contents: [{ 
                    role: "user", 
                    parts: [
                        { text: transcriptionPrompt },
                        { inlineData: { mimeType: imageFile.type, data: base64Data } }
                    ]
                }],
            };

            const jsonResponse = await withExponentialBackoff(() => fetch(geminiApiBaseUrl(model), {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify(payload)
            }));

            const text = jsonResponse.candidates?.[0]?.content?.parts?.[0]?.text;
            return text || null;

        } catch (err) {
            console.error("Transcription Error:", err);
            return null;
        }
    }, [accessToken]);

    const handleRunAnalysis = () => {
        if (!isLoggedIn) {
            setError("Please log in with your Google Account before running the analysis.");
            return;
        }

        if (selectedImage) {
            runAnalysis(inputText, selectedImage);
        } else if (inputText.trim()) {
            runAnalysis(inputText);
        } else {
            setError("Please paste text or select an image to analyze.");
        }
    };

    const handleRefreshSuggestions = () => {
        if (!isLoggedIn) {
            setError("Please log in with your Google Account to refresh suggestions.");
            return;
        }
        
        if (inputText.trim() || selectedImage) {
            runAnalysis(inputText, selectedImage);
        }
    };

    const suggestions = analysisResult?.errors || [];
    const headlines = analysisResult?.headlines || [];

    // --- UI Rendering ---
    return (
        <div className="min-h-screen bg-gray-50 p-4 sm:p-8 font-sans">
            <header className="mb-8 text-center bg-white p-6 rounded-xl shadow-lg border border-gray-200 sticky top-0 z-10">
                <div className="flex justify-between items-center max-w-7xl mx-auto">
                    <div>
                        <h1 className="text-2xl font-extrabold text-indigo-700">
                            Copy Editor Assistant
                        </h1>
                        <p className="text-gray-500 text-sm">
                            *Analysis uses your Google account API quota.
                        </p>
                    </div>
                    
                    {/* Authentication Status and Button */}
                    <div className="flex items-center space-x-3">
                        {userProfile ? (
                            <div className="flex items-center space-x-2 p-2 bg-indigo-50 rounded-full">
                                <img 
                                    src={userProfile.picture} 
                                    alt={userProfile.name} 
                                    className="w-8 h-8 rounded-full"
                                />
                                <span className="text-sm font-medium text-indigo-800 hidden sm:inline">{userProfile.given_name || userProfile.name}</span>
                                <button
                                    onClick={handleLogout}
                                    className="px-3 py-1 text-sm bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                                >
                                    Logout
                                </button>
                            </div>
                        ) : (
                            <button
                                id="google-login-button"
                                className="px-4 py-2 bg-indigo-600 text-white font-bold rounded-lg shadow-md hover:bg-indigo-700 transition-all duration-300 flex items-center disabled:opacity-50"
                                disabled={GOOGLE_CLIENT_ID === "YOUR_GOOGLE_CLIENT_ID_HERE"}
                            >
                                <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)">
                                    <path d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.82-.26.82-.577v-2.01c-3.336.726-4.04-1.608-4.04-1.608-.546-1.385-1.332-1.755-1.332-1.755-1.09-.745.083-.73.083-.73 1.205.085 1.839 1.24 1.839 1.24 1.07 1.835 2.809 1.305 3.495.998.109-.778.419-1.305.762-1.605-2.665-.3-5.466-1.33-5.466-5.947 0-1.314.47-2.385 1.235-3.224-.124-.303-.535-1.523.117-3.176 0 0 1.008-.323 3.301 1.238A11.41 11.41 0 0112 5.864c1.02.008 2.04.137 3.018.406 2.292-1.56 3.3-1.238 3.3-1.238.652 1.653.24 2.873.115 3.176.766.839 1.235 1.91 1.235 3.224 0 4.628-2.805 5.646-5.475 5.945.43.372.823 1.102.823 2.223v3.295c0 .318.219.687.823.577C20.563 21.8 24 17.302 24 12 24 5.373 18.627 0 12 0z"/>
                                </svg>
                                Sign in with Google
                            </button>
                        )}
                    </div>
                </div>
                
                {(error || authError) && (
                    <div className="mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg text-sm text-left">
                        <strong>Error:</strong> {error || authError}
                    </div>
                )}
            </header>

            <main className="max-w-7xl mx-auto mt-8">
                {/* Input and Controls Area */}
                <div className={`bg-white p-6 rounded-xl shadow-lg mb-8 border border-gray-200 ${!isLoggedIn ? 'opacity-50 pointer-events-none' : ''}`}>
                    <h2 className="text-xl font-semibold text-gray-700 mb-4">1. Story Input</h2>
                    
                    {/* Input Selection Tabs */}
                    <div className="flex space-x-4 mb-4 border-b pb-2">
                        <button 
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${!selectedImage ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-600 hover:bg-gray-100'}`}
                            onClick={() => setSelectedImage(null)}
                        >
                            Paste Text
                        </button>
                        <label 
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${selectedImage ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-600 hover:bg-gray-100'}`}
                        >
                            Upload Image (OCR)
                            <input type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
                        </label>
                    </div>

                    {/* Textarea or Image Preview */}
                    {!selectedImage ? (
                        <textarea
                            value={inputText}
                            onChange={handleTextChange}
                            rows="10"
                            placeholder={isLoggedIn ? "Paste your news story, draft article, or fact-check notes here..." : "Please log in above to enable input."}
                            className="w-full p-4 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm"
                            disabled={!isLoggedIn}
                        ></textarea>
                    ) : (
                        <div className="p-4 border border-gray-300 border-dashed rounded-lg text-center bg-gray-50">
                            <p className="text-gray-500 text-sm">
                                Image selected: <span className="font-medium text-indigo-600">{selectedImage.name}</span>
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                                Text will be extracted using Optical Character Recognition (OCR) and then analyzed.
                            </p>
                        </div>
                    )}
                    
                    {/* Action Button */}
                    <div className="mt-4 flex justify-between items-center">
                        <button
                            onClick={handleRunAnalysis}
                            disabled={processing || !isLoggedIn || (!inputText.trim() && !selectedImage)}
                            className="px-6 py-3 bg-indigo-600 text-white font-bold rounded-lg shadow-md hover:bg-indigo-700 disabled:bg-indigo-400 transition-all duration-300 flex items-center"
                        >
                            {processing ? (
                                <>
                                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Analyzing...
                                </>
                            ) : (
                                'Run Analysis'
                            )}
                        </button>
                    </div>
                </div>

                {/* Analysis Results Area */}
                {analysisResult && (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        
                        {/* Box 1: Highlighted Errors in Text */}
                        <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-lg border border-gray-200">
                            <h2 className="text-xl font-semibold text-gray-700 mb-4 flex justify-between items-center">
                                1. Original Text with Errors Highlighted (Red)
                                <span className="text-sm font-normal text-gray-400">{suggestions.length} errors found</span>
                            </h2>
                            <div className="h-96 overflow-y-auto border p-4 rounded-lg bg-gray-50 text-gray-800 leading-relaxed text-sm whitespace-pre-wrap">
                                {suggestions.length > 0 ? (
                                    <p className="inline">
                                        {highlightedContent}
                                    </p>
                                ) : (
                                    <p className="text-center text-green-600 font-medium">
                                        No significant errors detected. Great job!
                                    </p>
                                )}
                            </div>
                            <p className="text-xs text-gray-500 mt-2">
                                *Hover over the red text for the suggested improvement.
                            </p>
                        </div>
                        
                        {/* Box 2: Suggested Improvements List */}
                        <div className="lg:col-span-1 bg-white p-6 rounded-xl shadow-lg border border-gray-200">
                            <h2 className="text-xl font-semibold text-gray-700 mb-4">
                                2. Suggested Improvements
                            </h2>
                            <div className="h-96 overflow-y-auto border p-4 rounded-lg bg-gray-50 text-sm">
                                {suggestions.length > 0 ? (
                                    <ul className="space-y-3">
                                        {suggestions.slice(0, 10).map((s, index) => (
                                            <li key={index} className="p-3 bg-white rounded-lg shadow-sm border-l-4 border-yellow-500">
                                                <p className="text-gray-500 italic text-xs mb-1">({s.error_type || 'General Error'})</p>
                                                <p className="font-semibold text-gray-700">Original:</p>
                                                <p className="text-red-600 line-through text-xs mb-1">{s.original_phrase}</p>
                                                <p className="font-semibold text-gray-700 mt-2">Suggestion:</p>
                                                <p className="text-green-600 font-medium">{s.suggestion}</p>
                                            </li>
                                        ))}
                                        {suggestions.length > 10 && (
                                            <li className="text-center text-sm text-gray-500">
                                                ... and {suggestions.length - 10} more suggestions.
                                            </li>
                                        )}
                                    </ul>
                                ) : (
                                    <p className="text-center text-gray-500">
                                        All clear! No specific improvements suggested by the AI.
                                    </p>
                                )}
                            </div>
                            <div className="mt-4 flex justify-end">
                                <button
                                    onClick={handleRefreshSuggestions}
                                    disabled={processing || !isLoggedIn}
                                    className="px-4 py-2 text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                                >
                                    Refresh All Suggestions
                                </button>
                            </div>
                        </div>

                        {/* Box 3: Headline and Subheadline Suggestions */}
                        <div className="lg:col-span-3 bg-white p-6 rounded-xl shadow-lg border border-gray-200 mt-6">
                            <h2 className="text-xl font-semibold text-gray-700 mb-4">
                                3. Best Suggested Headlines & Subheadlines
                            </h2>
                            <div className="flex items-center space-x-4 mb-4">
                                <label className="text-sm font-medium text-gray-700">
                                    Number of Headlines (5-25):
                                </label>
                                <select
                                    value={headlineCount}
                                    onChange={(e) => setHeadlineCount(parseInt(e.target.value))}
                                    className="p-2 border border-gray-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                                    disabled={!isLoggedIn}
                                >
                                    {[...Array(21).keys()].map(i => {
                                        const count = i + 5;
                                        return <option key={count} value={count}>{count}</option>;
                                    })}
                                </select>
                                <button
                                    onClick={handleRefreshSuggestions}
                                    disabled={processing || !isLoggedIn}
                                    className="px-4 py-2 bg-indigo-100 text-indigo-700 font-medium rounded-lg hover:bg-indigo-200 transition-colors disabled:opacity-50"
                                >
                                    {processing ? 'Generating...' : 'Refresh Headlines'}
                                </button>
                            </div>

                            {headlines.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 h-96 overflow-y-auto pr-2">
                                    {headlines.map((h, index) => (
                                        <div key={index} className="p-4 bg-white border border-indigo-200 rounded-lg shadow-md hover:shadow-lg transition-all duration-300">
                                            <div className="text-2xl font-bold text-indigo-800 mb-1 leading-tight">{h.headline}</div>
                                            <p className="text-base text-gray-600 font-medium">{h.subheadline}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="p-10 text-center text-gray-500 border border-dashed rounded-lg">
                                    {isLoggedIn ? "Run analysis to generate headline suggestions." : "Log in to enable analysis and headline generation."}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};

export default App;
