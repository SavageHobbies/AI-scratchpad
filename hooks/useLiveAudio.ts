import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality, Blob, FunctionDeclaration, Type } from "@google/genai";
import { Transcript } from '../types';
import { encode, decode, decodeAudioData } from '../utils/audioUtils';

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const BUFFER_SIZE = 4096;

const addToScratchpadTool: FunctionDeclaration = {
  name: 'addToScratchpad',
  parameters: {
    type: Type.OBJECT,
    description: 'Adds content to the user\'s scratchpad for notes.',
    properties: {
      content: {
        type: Type.STRING,
        description: 'The text content to add to the scratchpad. This should be the specific information or numbers the user mentioned.',
      },
    },
    required: ['content'],
  },
};

export const useLiveAudio = (onAddToScratchpad: (content: string) => void) => {
    const [isConnecting, setIsConnecting] = useState<boolean>(false);
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const [transcriptHistory, setTranscriptHistory] = useState<Transcript[]>([]);
    const [currentUserUtterance, setCurrentUserUtterance] = useState('');
    const [currentModelUtterance, setCurrentModelUtterance] = useState('');
    const [error, setError] = useState<string | null>(null);

    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    
    const nextStartTimeRef = useRef(0);
    const audioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
    const audioLevelRef = useRef(0);
    const transcriptIdCounter = useRef(0);
    
    // Use refs to store the latest utterance text to avoid stale closures in callbacks.
    const userUtteranceRef = useRef('');
    const modelUtteranceRef = useRef('');

    const playAudio = useCallback(async (base64Audio: string) => {
        if (!outputAudioContextRef.current) return;
        const audioContext = outputAudioContextRef.current;
        
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContext.currentTime);
        const audioBuffer = await decodeAudioData(
            decode(base64Audio),
            audioContext,
            OUTPUT_SAMPLE_RATE,
            1,
        );
        
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        
        source.addEventListener('ended', () => {
            audioSourcesRef.current.delete(source);
        });
        
        source.start(nextStartTimeRef.current);
        nextStartTimeRef.current += audioBuffer.duration;
        audioSourcesRef.current.add(source);
    }, []);
    
    const stopAllPlayback = useCallback(() => {
        audioSourcesRef.current.forEach(source => source.stop());
        audioSourcesRef.current.clear();
        nextStartTimeRef.current = 0;
    }, []);
    
    const commitFinalUtterances = useCallback(() => {
        const finalTranscripts: Transcript[] = [];
        if (userUtteranceRef.current) {
            finalTranscripts.push({
                id: `t_${++transcriptIdCounter.current}`,
                text: userUtteranceRef.current,
                source: 'user',
            });
        }
        if (modelUtteranceRef.current) {
            finalTranscripts.push({
                id: `t_${++transcriptIdCounter.current}`,
                text: modelUtteranceRef.current,
                source: 'model',
            });
        }
        
        if (finalTranscripts.length > 0) {
            setTranscriptHistory(prev => [...prev, ...finalTranscripts]);
        }

        userUtteranceRef.current = '';
        modelUtteranceRef.current = '';
        setCurrentUserUtterance('');
        setCurrentModelUtterance('');
    }, []);


    const stopSession = useCallback(async () => {
        if (sessionPromiseRef.current) {
            try {
                const session = await sessionPromiseRef.current;
                session.close();
            } catch (e) {
                console.error("Error closing session:", e);
            }
        }
        sessionPromiseRef.current = null;

        mediaStreamRef.current?.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }
         if (sourceNodeRef.current) {
            sourceNodeRef.current.disconnect();
            sourceNodeRef.current = null;
        }
        
        if (inputAudioContextRef.current?.state !== 'closed') {
            await inputAudioContextRef.current?.close().catch(console.error);
        }

        stopAllPlayback();
        if (outputAudioContextRef.current?.state !== 'closed') {
            await outputAudioContextRef.current?.close().catch(console.error);
        }

        audioLevelRef.current = 0;
        setIsConnected(false);
        setIsConnecting(false);
        commitFinalUtterances();

    }, [stopAllPlayback, commitFinalUtterances]);

    const startSession = useCallback(async () => {
        setIsConnecting(true);
        setError(null);
        setTranscriptHistory([]);
        userUtteranceRef.current = '';
        modelUtteranceRef.current = '';
        setCurrentUserUtterance('');
        setCurrentModelUtterance('');
        transcriptIdCounter.current = 0;

        try {
            if (!outputAudioContextRef.current || outputAudioContextRef.current.state === 'closed') {
                outputAudioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
            }
            if (outputAudioContextRef.current.state === 'suspended') {
                await outputAudioContextRef.current.resume();
            }
            
            mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            inputAudioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });

            const freshAI = new GoogleGenAI({ apiKey: API_KEY });

            const sessionPromise = freshAI.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        setIsConnecting(false);
                        setIsConnected(true);
                        
                        if (!inputAudioContextRef.current || !mediaStreamRef.current) return;

                        sourceNodeRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
                        scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(BUFFER_SIZE, 1, 1);

                        scriptProcessorRef.current.onaudioprocess = (event: AudioProcessingEvent) => {
                            const inputData = event.inputBuffer.getChannelData(0);

                            let sum = 0.0;
                            for (let i = 0; i < inputData.length; i++) {
                                sum += inputData[i] * inputData[i];
                            }
                            audioLevelRef.current = Math.sqrt(sum / inputData.length);

                            const pcmBlob: Blob = {
                                data: encode(new Uint8Array(new Int16Array(inputData.map(f => f * 32768)).buffer)),
                                mimeType: 'audio/pcm;rate=16000',
                            };
                            
                            sessionPromiseRef.current?.then(session => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            }).catch(e => {
                                console.error("Error sending audio data:", e);
                            });
                        };
                        
                        sourceNodeRef.current.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        if (message.toolCall?.functionCalls) {
                            for (const fc of message.toolCall.functionCalls) {
                                if (fc.name === 'addToScratchpad' && fc.args.content) {
                                    onAddToScratchpad(fc.args.content as string);
                                    sessionPromiseRef.current?.then(session => {
                                        session.sendToolResponse({
                                            functionResponses: [{
                                                id: fc.id,
                                                name: fc.name,
                                                response: { result: "ok, content added." },
                                            }]
                                        });
                                    });
                                }
                            }
                        }

                        if (message.serverContent?.inputTranscription) {
                            const text = message.serverContent.inputTranscription.text;
                            userUtteranceRef.current += text;
                        }
                        
                        if (message.serverContent?.outputTranscription) {
                           const text = message.serverContent.outputTranscription.text;
                           modelUtteranceRef.current += text;
                        }

                        if (message.serverContent?.turnComplete) {
                            const finalUserText = userUtteranceRef.current.trim();
                            const finalModelText = modelUtteranceRef.current.trim();
                            const transcriptsToAdd : Transcript[] = [];

                            if (finalUserText) {
                                transcriptsToAdd.push({ id: `t_${++transcriptIdCounter.current}`, text: finalUserText, source: 'user' });
                            }
                            if (finalModelText) {
                                transcriptsToAdd.push({ id: `t_${++transcriptIdCounter.current}`, text: finalModelText, source: 'model' });
                            }
                            
                            if (transcriptsToAdd.length > 0) {
                                setTranscriptHistory(prev => [...prev, ...transcriptsToAdd]);
                            }

                            userUtteranceRef.current = '';
                            modelUtteranceRef.current = '';
                        }
                        
                        const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                        if (base64Audio) {
                            await playAudio(base64Audio);
                        }
                        
                        if (message.serverContent?.interrupted) {
                            stopAllPlayback();
                        }
                    },
                    onerror: (e: ErrorEvent) => {
                        console.error('Live session error:', e);
                        setError(`Live session error:\n${e.message || 'Unknown error'}`);
                        stopSession();
                    },
                    onclose: (e: CloseEvent) => {
                        stopSession();
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    tools: [{ functionDeclarations: [addToScratchpadTool] }],
                },
            });

            sessionPromiseRef.current = sessionPromise;

        } catch (err: any) {
            console.error('Failed to start session:', err);
setError(`Failed to start session: ${err.message || 'Could not access microphone or another setup error occurred.'}`);
            setIsConnecting(false);
            stopSession();
        }
    }, [playAudio, stopAllPlayback, stopSession, onAddToScratchpad]);

    return { 
        isConnecting, 
        isConnected, 
        transcriptHistory, 
        error, 
        startSession, 
        stopSession, 
        audioLevelRef,
    };
};