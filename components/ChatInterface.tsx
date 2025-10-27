import React, { useState, useCallback, useRef, useEffect } from 'react';
import { AppMode, ChatMessage, Transcript } from '../types';
import { getChatResponse, getTextToSpeech, resetChat, organizeNotes, summarizeConversation } from '../services/geminiService';
import { decode, decodeAudioData } from '../utils/audioUtils';
import { useLiveAudio } from '../hooks/useLiveAudio';
import { MicrophoneIcon, PlayIcon, StopIcon, SendIcon, LoadingSpinner, PlusIcon, DownloadIcon, SparklesIcon } from './IconComponents';

// Helper function to split text into chunks that respect sentence boundaries
function chunkText(text: string, maxLength: number): string[] {
    const sentences = text.match(/[^.!?]+[.!?]*\s*|.+/g) || [];
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if (sentence.length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = "";
            }
            for (let i = 0; i < sentence.length; i += maxLength) {
                chunks.push(sentence.substring(i, i + maxLength));
            }
            continue;
        }
        
        if ((currentChunk + sentence).length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk);
            }
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks.filter(c => c.trim().length > 0);
}

const AudioVisualizer: React.FC<{ audioLevelRef: React.RefObject<number> }> = ({ audioLevelRef }) => {
    const [displayLevel, setDisplayLevel] = useState(0);
    const animationFrameId = useRef<number>();

    useEffect(() => {
        const animate = () => {
            const currentLevel = audioLevelRef.current || 0;
            setDisplayLevel(prevLevel => Math.max(currentLevel, prevLevel * 0.9 - 0.01));
            animationFrameId.current = requestAnimationFrame(animate);
        };
        animationFrameId.current = requestAnimationFrame(animate);
        return () => {
            if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
        };
    }, [audioLevelRef]);

    const numDots = 8;
    const activeDots = Math.min(numDots, Math.ceil(displayLevel * 15));

    return (
        <div className="flex flex-col items-center justify-center h-full space-y-3 py-4 w-full">
            {Array.from({ length: numDots }).map((_, i) => (
                <div
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full transition-all duration-100 ${
                        i < activeDots ? 'bg-purple-400 scale-110 shadow-[0_0_8px_theme(colors.purple.400)]' : 'bg-slate-600'
                    }`}
                />
            ))}
        </div>
    );
};

const LiveChatBubble: React.FC<{transcript: Transcript}> = ({ transcript }) => {
    const role = transcript.source.startsWith('user') ? 'user' : 'model';
    
    if (role === 'user') {
        return (
            <div className="flex flex-col items-end fade-in">
                <div className="chat-bubble relative max-w-md p-3 rounded-2xl shadow-md chat-bubble-user text-white rounded-br-lg">
                    <span className="user-label-internal">You</span>
                    <p className="text-sm whitespace-pre-wrap pt-4">{transcript.text}</p>
                </div>
            </div>
        );
    }
    
    return (
        <div className="flex flex-col items-start space-y-1 fade-in">
             <span className="ai-label-v2 ml-1">AI</span>
            <div className="chat-bubble max-w-md p-3 rounded-2xl shadow-md chat-bubble-model rounded-bl-lg">
                <p className="text-sm whitespace-pre-wrap">{transcript.text}</p>
            </div>
        </div>
    );
};


const ChatInterface: React.FC = () => {
    const [mode, setMode] = useState<AppMode>(AppMode.TextChat);
    const [contextText, setContextText] = useState<string>('');
    const [pastedText, setPastedText] = useState<string>('');
    
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState<string>('');
    const [isThinking, setIsThinking] = useState<boolean>(false);
    const [ttsStatus, setTtsStatus] = useState<'idle' | 'fetching' | 'playing'>('idle');
    const [activeSentenceIndex, setActiveSentenceIndex] = useState<number | null>(null);

    // Live conversation state
    const [sessionEnded, setSessionEnded] = useState(false);
    const [scratchpadText, setScratchpadText] = useState('');
    const [isCleaningNotes, setIsCleaningNotes] = useState(false);
    
    // Summary State
    const [summary, setSummary] = useState<string | null>(null);
    const [isSummarizing, setIsSummarizing] = useState(false);

    // Refs for TTS audio playback
    const ttsAudioContextRef = useRef<AudioContext | null>(null);
    const ttsAudioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
    const nextTtsStartTimeRef = useRef(0);
    const isCancelledRef = useRef(false);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    
    const handleAddToScratchpad = useCallback((content: string) => {
        setScratchpadText(prev => prev ? `${prev}\n- ${content}` : `- ${content}`);
    }, []);

    const { 
        isConnecting, 
        isConnected, 
        transcriptHistory,
        error, 
        startSession, 
        stopSession, 
        audioLevelRef,
    } = useLiveAudio(handleAddToScratchpad);
    
    // Auto-scroll transcript
    useEffect(() => {
        if (mode === AppMode.LiveConversation) {
            transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [transcriptHistory, mode]);

    const stopTtsPlayback = useCallback(() => {
        isCancelledRef.current = true;
        ttsAudioSourcesRef.current.forEach(source => {
            try {
                source.stop();
            } catch (e) {
                // Ignore errors, e.g., if source already stopped
            }
        });
        ttsAudioSourcesRef.current.clear();
        nextTtsStartTimeRef.current = 0;
        setTtsStatus('idle');
        setActiveSentenceIndex(null); // Clear highlight
    }, []);

    useEffect(() => {
        return () => {
            stopTtsPlayback();
            if (ttsAudioContextRef.current && ttsAudioContextRef.current.state !== 'closed') {
              ttsAudioContextRef.current.close();
            }
            if (isConnected) {
                stopSession();
            }
        };
    }, [isConnected, stopSession, stopTtsPlayback]);

    const handleContextSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setChatHistory([]);
        resetChat();
        setSummary(null);
        setContextText(pastedText);
    };

    const handleNewContext = () => {
        setContextText('');
        setPastedText('');
        setChatHistory([]);
        resetChat();
        stopTtsPlayback();
        setSummary(null);
    };

    const handleSendMessage = async () => {
        if (!inputValue.trim() || isThinking) return;
        
        setSummary(null);
        const newUserMessage: ChatMessage = { role: 'user', text: inputValue };
        setChatHistory(prev => [...prev, newUserMessage]);
        setInputValue('');
        setIsThinking(true);

        try {
            const response = await getChatResponse(contextText, inputValue);
            const modelMessage: ChatMessage = { role: 'model', text: response.text };
            setChatHistory(prev => [...prev, modelMessage]);
        } catch (e) {
            console.error("Error sending message:", e);
            const errorMessage: ChatMessage = { role: 'model', text: 'Sorry, I encountered an error. Please try again.' };
            setChatHistory(prev => [...prev, errorMessage]);
        } finally {
            setIsThinking(false);
        }
    };
    
    const getTtsAudioContext = useCallback(() => {
        if (!ttsAudioContextRef.current || ttsAudioContextRef.current.state === 'closed') {
             const AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
             if (AudioContext) {
                ttsAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
             }
        }
        return ttsAudioContextRef.current;
    }, []);
    
    const queueAndPlayAudio = useCallback(async (base64Audio: string) => {
        const audioContext = getTtsAudioContext();
        if (!audioContext) return;

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        const decoded = decode(base64Audio);
        const buffer = await decodeAudioData(decoded, audioContext, 24000, 1);
        
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        
        const scheduledTime = Math.max(nextTtsStartTimeRef.current, audioContext.currentTime);
        source.start(scheduledTime);
        
        nextTtsStartTimeRef.current = scheduledTime + buffer.duration;
        ttsAudioSourcesRef.current.add(source);
        
        source.onended = () => {
            ttsAudioSourcesRef.current.delete(source);
            if (ttsAudioSourcesRef.current.size === 0 && !isCancelledRef.current) {
                setTtsStatus('idle');
                setActiveSentenceIndex(null);
            }
        };

    }, [getTtsAudioContext]);

    const handleReadAloud = useCallback(async () => {
        if (ttsStatus === 'fetching') {
            stopTtsPlayback();
            return;
        }
        if (ttsStatus === 'playing') {
            stopTtsPlayback();
            return;
        }

        const sentences = contextText.split('\n').flatMap(p => p.match(/[^.!?]+[.!?]*\s*|.+/g) || []);
        let textToRead = contextText;

        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
            textToRead = selection.toString();
        } else if (activeSentenceIndex !== null && sentences[activeSentenceIndex]) {
            textToRead = sentences.slice(activeSentenceIndex).join('');
        }

        if (!textToRead) return;
        
        isCancelledRef.current = false;
        setTtsStatus('fetching');

        const TTS_CHARACTER_LIMIT = 5000;
        const chunks = chunkText(textToRead, TTS_CHARACTER_LIMIT);

        if (chunks.length === 0) {
            setTtsStatus('idle');
            return;
        }

        let hasFailed = false;
        let firstChunkProcessed = false;
        nextTtsStartTimeRef.current = 0;

        for (const chunk of chunks) {
            if (isCancelledRef.current) {
                 break;
            }
            try {
                const audioData = await getTextToSpeech(chunk);
                if (audioData && !isCancelledRef.current) {
                    if (!firstChunkProcessed) {
                        setTtsStatus('playing');
                        firstChunkProcessed = true;
                    }
                    await queueAndPlayAudio(audioData);
                } else if (!audioData) {
                    console.error(`Failed to generate audio for chunk: ${chunk.substring(0, 50)}...`);
                    hasFailed = true;
                    break; 
                }
            } catch (e) {
                console.error("Error fetching TTS data:", e);
                hasFailed = true;
                break;
            }
        }
        
        if (hasFailed || isCancelledRef.current) {
            if(hasFailed) alert('An error occurred while generating speech. Please check the console for details.');
            stopTtsPlayback();
        }
    }, [contextText, queueAndPlayAudio, stopTtsPlayback, ttsStatus, activeSentenceIndex]);

    const handleSentenceClick = (paragraphIndex: number, sentenceIndexInParagraph: number) => {
        const paragraphs = contextText.split('\n').filter(p => p.trim() !== '');
        let overallSentenceIndex = 0;
        for (let i = 0; i < paragraphIndex; i++) {
          overallSentenceIndex += (paragraphs[i].match(/[^.!?]+[.!?]*\s*|.+/g) || []).length;
        }
        overallSentenceIndex += sentenceIndexInParagraph;

        if (ttsStatus !== 'idle') {
            stopTtsPlayback();
        } else {
            setActiveSentenceIndex(prev => (prev === overallSentenceIndex ? null : overallSentenceIndex));
        }
    };
    
    const handleStartLiveSession = () => {
        setSessionEnded(false);
        setSummary(null);
        setScratchpadText('');
        startSession(contextText);
    };

    const handleStopLiveSession = () => {
        stopSession();
        setSessionEnded(true);
    };

    const handleCleanUpNotes = async () => {
        setIsCleaningNotes(true);
        const organized = await organizeNotes(scratchpadText);
        setScratchpadText(organized);
        setIsCleaningNotes(false);
    };

    const handleDownloadTranscript = () => {
        const formattedTranscript = transcriptHistory
            .map(t => {
                const speaker = t.source.startsWith('user') ? 'You' : 'AI';
                return `${speaker}: ${t.text}`;
            })
            .join('\n\n');
        
        const blob = new Blob([formattedTranscript], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `AI-Conversation-Transcript-${new Date().toISOString()}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };
    
    const handleSummarize = async () => {
        setIsSummarizing(true);
        setSummary(null);
        const history = mode === AppMode.TextChat ? chatHistory : transcriptHistory;
        const result = await summarizeConversation(history);
        setSummary(result);
        setIsSummarizing(false);
    };

    const ReadAloudButton = () => {
        let icon = <PlayIcon className="w-5 h-5" />;
        let text = "Read Aloud";
        let buttonClass = "btn-gradient-primary";

        switch (ttsStatus) {
            case 'fetching':
                icon = <LoadingSpinner className="w-5 h-5" />;
                text = "Cancel";
                buttonClass = "bg-yellow-600 hover:bg-yellow-500";
                break;
            case 'playing':
                icon = <StopIcon className="w-5 h-5" />;
                text = "Stop Reading";
                buttonClass = "bg-red-600 hover:bg-red-500";
                break;
        }

        return (
             <button
                onClick={handleReadAloud}
                className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-white font-semibold transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed shadow-md hover:shadow-lg hover:scale-105 ${buttonClass}`}
            >
                {icon}
                <span>{text}</span>
            </button>
        );
    };

    const ModeButton: React.FC<{
      targetMode: AppMode;
      children: React.ReactNode;
    }> = ({ targetMode, children }) => (
      <button
        onClick={() => setMode(targetMode)}
        className={`w-full py-3 text-sm font-medium transition-all duration-300 rounded-lg ${
          mode === targetMode
            ? 'btn-gradient-primary text-white shadow-lg shadow-purple-600/30'
            : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300'
        }`}
      >
        {children}
      </button>
    );

    const renderTextChat = () => (
        <div className="p-4 sm:p-6 h-[75vh] flex flex-col">
            {!contextText ? (
                <form onSubmit={handleContextSubmit} className="flex-grow flex flex-col justify-center space-y-4">
                    <div>
                        <label htmlFor="context-paste-area" className="block text-lg font-medium text-slate-300 mb-2">
                            Provide Text to Discuss
                        </label>
                        <textarea 
                            id="context-paste-area"
                            value={pastedText} 
                            onChange={e => setPastedText(e.target.value)} 
                            placeholder="Paste text from an article or document here..." 
                            className="w-full h-96 p-3 bg-slate-900/80 border border-slate-700 rounded-lg focus:ring-2 focus:ring-purple-500 focus:outline-none transition-all" 
                        />
                         <p className="text-xs text-slate-500 mt-2">
                            Tip: To discuss content from a web page, please copy and paste the text here. Direct URL fetching is not supported due to browser security restrictions.
                        </p>
                    </div>
                    <button 
                        type="submit" 
                        className="w-full btn-gradient-secondary text-white font-bold py-3 px-4 rounded-lg transition-transform duration-200 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-cyan-500/30" 
                        disabled={!pastedText.trim()}
                    >
                        Start Conversation
                    </button>
                </form>
            ) : (
                <div className="flex flex-col h-full">
                    <div className="border-b border-slate-700 pb-4 mb-4">
                        <div className="flex flex-col">
                            <div className="mb-4">
                                <h3 className="font-semibold text-slate-300 mb-2">Context:</h3>
                                <div className="text-sm text-slate-300 max-h-96 overflow-y-auto pr-2 rounded-md bg-slate-900/50 p-3 custom-scrollbar">
                                  {contextText.split('\n').filter(p => p.trim() !== '').map((paragraph, pIndex) => {
                                      let sentenceCountBefore = 0;
                                      if (pIndex > 0) {
                                        sentenceCountBefore = contextText.split('\n').slice(0, pIndex)
                                          .reduce((acc, curr) => acc + (curr.match(/[^.!?]+[.!?]*\s*|.+/g) || []).length, 0);
                                      }
                                      return (
                                        <p key={pIndex} className="mb-2">
                                          {(paragraph.match(/[^.!?]+[.!?]*\s*|.+/g) || []).map((sentence, sIndex) => {
                                              const overallSentenceIndex = sentenceCountBefore + sIndex;
                                              return (
                                                  <span
                                                    key={sIndex}
                                                    onClick={() => handleSentenceClick(pIndex, sIndex)}
                                                    className={`cursor-pointer transition-colors duration-200 rounded px-1 ${
                                                      activeSentenceIndex === overallSentenceIndex
                                                        ? 'bg-purple-500/40 text-slate-100'
                                                        : 'hover:bg-slate-700/80'
                                                    }`}
                                                  >
                                                    {sentence}
                                                  </span>
                                              );
                                          })}
                                        </p>
                                      );
                                  })}
                                </div>
                            </div>
                            <div className="flex justify-between items-center">
                                <ReadAloudButton />
                                <button onClick={handleNewContext} className="text-sm text-cyan-400 hover:underline">New Context</button>
                            </div>
                            <p className="text-xs text-slate-500 mt-2 text-left">
                                Tip: Click any sentence to select a starting point for reading.
                            </p>
                        </div>
                    </div>
                    <div className="flex-grow overflow-y-auto pr-2 space-y-4 custom-scrollbar">
                        {chatHistory.map((msg, index) => (
                            <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} fade-in`}>
                                <div className={`chat-bubble max-w-md p-3 rounded-xl shadow-md ${msg.role === 'user' ? 'chat-bubble-user text-white' : 'chat-bubble-model'}`}>
                                    <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                                </div>
                            </div>
                        ))}
                         {isThinking && (
                            <div className="flex justify-start fade-in">
                                <div className="max-w-md p-3 rounded-xl chat-bubble-model">
                                   <LoadingSpinner className="w-5 h-5 text-slate-300"/>
                                </div>
                            </div>
                        )}
                        {summary && !isSummarizing && (
                            <div className="p-4 bg-slate-900/70 border border-slate-700 rounded-lg mt-4 fade-in">
                                <h4 className="font-semibold text-cyan-300 mb-2">Conversation Summary</h4>
                                <p className="text-sm whitespace-pre-wrap text-slate-300">{summary}</p>
                            </div>
                        )}
                    </div>
                    
                    {chatHistory.length > 0 && (
                         <div className="mt-4 flex justify-center">
                            <button onClick={handleSummarize} disabled={isSummarizing} className="px-4 py-2 btn-gradient-secondary rounded-lg text-white font-semibold flex items-center space-x-2 hover:opacity-90 transition-opacity disabled:opacity-50 shadow-md">
                                {isSummarizing ? <LoadingSpinner className="w-5 h-5"/> : <SparklesIcon className="w-5 h-5"/>}
                                <span>{isSummarizing ? 'Summarizing...' : 'Summarize'}</span>
                            </button>
                        </div>
                    )}
                    
                    <div className="mt-4 flex items-center space-x-2">
                        <input type="text" value={inputValue} onChange={e => setInputValue(e.target.value)} onKeyPress={e => e.key === 'Enter' && handleSendMessage()} placeholder="Ask a question about the text..." className="w-full p-3 bg-slate-900/80 border border-slate-700 rounded-lg focus:ring-2 focus:ring-purple-500 focus:outline-none transition-all" />
                        <button onClick={handleSendMessage} className="p-3 btn-gradient-primary rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors shadow-md" disabled={isThinking}>
                            <SendIcon className="w-6 h-6"/>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
    
    const renderLiveConversation = () => {
        return (
            <div className="p-4 sm:p-6 h-[75vh] flex flex-col main-content-bg">
                <div className="w-full h-full flex flex-row gap-6">
                    {/* Left Panel: Transcript */}
                    <div className="flex-[2] flex flex-col h-full">
                         <div className="mb-4">
                            <h3 className="transcript-header-v2">Conversation Transcript</h3>
                         </div>
                        <div className="flex-grow overflow-y-auto space-y-6 pr-4 custom-scrollbar relative">
                           {(!isConnected && !isConnecting && !sessionEnded) && (
                               <div className="h-full flex flex-col items-center justify-center text-center">
                                    <h2 className="text-xl font-bold mb-4">Live Conversation Mode</h2>
                                    {contextText && (
                                        <div className="mb-4 p-3 bg-slate-800/50 border border-slate-700 rounded-lg text-center text-sm w-full max-w-md">
                                            <p className="text-slate-300">
                                                <span className="font-bold text-cyan-400">Context Loaded:</span> The AI is ready to discuss the document you provided.
                                            </p>
                                        </div>
                                    )}
                                    <p className="text-slate-400 mb-6">Click the button to start a real-time voice conversation with the AI.</p>
                                    <button onClick={handleStartLiveSession} className="px-8 py-4 btn-gradient-primary rounded-full text-white font-bold flex items-center space-x-3 hover:opacity-90 transition-transform hover:scale-105 shadow-lg shadow-purple-600/30">
                                        <MicrophoneIcon className="w-6 h-6" />
                                        <span>Start Conversation</span>
                                    </button>
                                    {error && <p className="text-red-400 mt-4 text-sm whitespace-pre-wrap">{error}</p>}
                               </div>
                           )}
                           {isConnecting && (
                                <div className="h-full flex flex-col items-center justify-center text-center">
                                    <LoadingSpinner className="w-12 h-12 text-purple-400 mx-auto mb-4"/>
                                    <p className="text-slate-400">Connecting...</p>
                                </div>
                           )}
                           
                           {transcriptHistory.map((t) => <LiveChatBubble key={t.id} transcript={t} />)}

                            {summary && !isSummarizing && (
                                <div className="p-4 bg-slate-900/70 border border-slate-700 rounded-lg my-4 fade-in">
                                    <h4 className="font-semibold text-cyan-300 mb-2">Conversation Summary</h4>
                                    <p className="text-sm whitespace-pre-wrap text-slate-300">{summary}</p>
                                </div>
                            )}
                           {sessionEnded && transcriptHistory.length === 0 && !summary && (
                               <div className="text-slate-500 text-center pt-8">
                                   Conversation ended. No transcript was generated.
                               </div>
                           )}
                           <div ref={transcriptEndRef} />
                        </div>
                         <div className="pt-4 flex justify-center">
                            {isConnected && (
                                <button onClick={handleStopLiveSession} className="px-6 py-3 bg-red-600 rounded-xl text-white font-semibold flex items-center space-x-2 hover:bg-red-500 transition-transform hover:scale-105 shadow-lg shadow-red-600/30">
                                    <StopIcon className="w-4 h-4" />
                                    <span>End Conversation</span>
                                </button>
                            )}
                            {sessionEnded && (
                                 <div className="flex items-center gap-2">
                                    <button onClick={handleStartLiveSession} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full text-white font-bold flex items-center space-x-3 hover:opacity-90 transition-transform hover:scale-105 shadow-lg shadow-purple-600/30">
                                        <MicrophoneIcon className="w-5 h-5" />
                                        <span>Start New Conversation</span>
                                    </button>
                                     {transcriptHistory.length > 0 && (
                                        <>
                                            <button onClick={handleSummarize} disabled={isSummarizing} className="px-4 py-3 btn-gradient-secondary rounded-full text-white font-semibold flex items-center space-x-2 hover:opacity-90 transition-opacity disabled:opacity-50 shadow-md">
                                                {isSummarizing ? <LoadingSpinner className="w-5 h-5"/> : <SparklesIcon className="w-5 h-5"/>}
                                                <span>{isSummarizing ? '...' : 'Summarize'}</span>
                                            </button>
                                            <button onClick={handleDownloadTranscript} className="p-3 bg-slate-700 rounded-full text-white font-semibold flex items-center space-x-2 hover:bg-slate-600 transition-colors shadow-md">
                                                <DownloadIcon className="w-5 h-5" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    
                    <div className="w-px bg-slate-700/50 relative">
                        {isConnected && 
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                <AudioVisualizer audioLevelRef={audioLevelRef} />
                            </div>
                        }
                    </div>

                    <div className="flex-1 flex-shrink-0 flex flex-col h-full">
                         <div className="flex-grow flex flex-col">
                             <div className="p-3 mb-4 bg-slate-800/80 border-l-4 border-cyan-400 text-slate-300 text-sm rounded-r-lg">
                                <p className="font-bold text-white mb-1">Using the Scratchpad</p>
                                <p className="text-xs">You can type notes here directly.</p>
                             </div>
                             <h3 className="text-lg font-semibold mb-2 text-slate-300">Scratchpad</h3>
                             <textarea 
                                value={scratchpadText}
                                onChange={(e) => setScratchpadText(e.target.value)}
                                placeholder="Jot down notes, numbers, or ideas here..."
                                className="w-full flex-grow p-3 bg-slate-900/80 border border-slate-700 rounded-lg focus:ring-2 focus:ring-purple-500 focus:outline-none transition-all resize-none text-sm custom-scrollbar"
                            />
                            <button 
                                onClick={handleCleanUpNotes}
                                disabled={isCleaningNotes || !scratchpadText.trim()}
                                className="mt-2 w-full flex justify-center items-center gap-2 btn-gradient-secondary text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:opacity-90"
                            >
                                {isCleaningNotes ? <LoadingSpinner className="w-5 h-5"/> : <><SparklesIcon className="w-4 h-4"/> Clean Up Notes</>}
                            </button>
                         </div>
                    </div>
                </div>
            </div>
        )
    };

    return (
        <div>
            <div className="grid grid-cols-2 gap-2 p-2">
               <ModeButton targetMode={AppMode.TextChat}>Chat About Text</ModeButton>
               <ModeButton targetMode={AppMode.LiveConversation}>Live Conversation</ModeButton>
            </div>
            <div className="border-t border-slate-800/80">
                {mode === AppMode.TextChat ? renderTextChat() : renderLiveConversation()}
            </div>
        </div>
    );
};

export default ChatInterface;