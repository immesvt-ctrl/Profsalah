
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SYSTEM_INSTRUCTION, CHAPTERS } from './constants';
import { ConnectionStatus, Message } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio-utils';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const transcriptRef = useRef<{ user: string; assistant: string }>({ user: '', assistant: '' });

  const addMessage = (role: 'user' | 'assistant', text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: new Date() }]);
  };

  const startSession = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      // Initialize audio contexts
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsRecording(true);
            
            // Start streaming microphone
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
            (sessionRef.current as any) = { scriptProcessor, source };
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio output
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            // Transcriptions
            if (message.serverContent?.inputTranscription) {
              transcriptRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptRef.current.assistant += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (transcriptRef.current.user) addMessage('user', transcriptRef.current.user);
              if (transcriptRef.current.assistant) addMessage('assistant', transcriptRef.current.assistant);
              transcriptRef.current = { user: '', assistant: '' };
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Gemini error:', e);
            setStatus(ConnectionStatus.ERROR);
            setError("Erreur de connexion avec l'assistant.");
          },
          onclose: () => {
            stopSession();
          },
        },
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error(err);
      setStatus(ConnectionStatus.ERROR);
      setError("Impossible d'accéder au micro ou de contacter l'IA.");
    }
  };

  const stopSession = () => {
    if (sessionRef.current && sessionRef.current.close) {
      sessionRef.current.close();
    }
    if (sessionRef.current?.scriptProcessor) {
      sessionRef.current.scriptProcessor.disconnect();
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
    }
    setIsRecording(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  };

  const toggleSession = () => {
    if (status === ConnectionStatus.CONNECTED) {
      stopSession();
    } else {
      startSession();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-teal-50">
      {/* Header */}
      <header className="bg-teal-600 text-white p-4 shadow-md sticky top-0 z-10">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center">
              <span className="text-teal-600 font-bold text-xl">EO</span>
            </div>
            <div>
              <h1 className="text-xl font-bold">Assistant SVT</h1>
              <p className="text-xs text-teal-100">Professeur EL OMRANI</p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <span className={`w-3 h-3 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-400 voice-pulse' : 'bg-gray-400'}`}></span>
            <span className="text-sm font-medium">
              {status === ConnectionStatus.CONNECTED ? 'En ligne' : status === ConnectionStatus.CONNECTING ? 'Connexion...' : 'Déconnecté'}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto p-4 flex flex-col space-y-4">
        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <section className="bg-white p-4 rounded-xl shadow-sm border border-teal-100">
            <h2 className="text-teal-800 font-semibold mb-2 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
              Chapitres Disponibles
            </h2>
            <div className="flex flex-wrap gap-2">
              {CHAPTERS.map(c => (
                <span key={c} className="bg-teal-50 text-teal-700 text-xs px-2 py-1 rounded-full border border-teal-200">
                  {c}
                </span>
              ))}
            </div>
          </section>

          <section className="bg-white p-4 rounded-xl shadow-sm border border-teal-100">
            <h2 className="text-teal-800 font-semibold mb-2 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              Comment ça marche ?
            </h2>
            <p className="text-gray-600 text-sm">
              Cliquez sur le bouton micro et posez votre question sur le cours de SVT. L'IA vous répondra à voix haute comme un vrai professeur !
            </p>
          </section>
        </div>

        {/* Chat History */}
        <div className="flex-1 bg-white rounded-2xl shadow-inner border border-teal-100 p-6 overflow-y-auto space-y-4 max-h-[50vh]">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 space-y-2">
              <svg className="w-16 h-16 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
              <p>Commencez la conversation pour voir l'historique ici.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] p-3 rounded-2xl ${m.role === 'user' ? 'bg-teal-600 text-white rounded-tr-none' : 'bg-gray-100 text-gray-800 rounded-tl-none'}`}>
                  <p className="text-sm">{m.text}</p>
                  <span className="text-[10px] opacity-70 block mt-1">
                    {m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex items-center border border-red-200">
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {error}
          </div>
        )}

        {/* Action Button Area */}
        <div className="flex justify-center items-center py-6">
          <button
            onClick={toggleSession}
            disabled={status === ConnectionStatus.CONNECTING}
            className={`
              relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 shadow-xl
              ${status === ConnectionStatus.CONNECTED 
                ? 'bg-red-500 hover:bg-red-600' 
                : 'bg-teal-600 hover:bg-teal-700'}
              ${status === ConnectionStatus.CONNECTING ? 'opacity-50 cursor-not-allowed' : 'scale-100 hover:scale-105 active:scale-95'}
            `}
          >
            {status === ConnectionStatus.CONNECTED && (
              <div className="absolute inset-0 rounded-full bg-red-400 opacity-30 voice-pulse"></div>
            )}
            {status === ConnectionStatus.CONNECTED ? (
              <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H10a1 1 0 01-1-1v-4z" /></svg>
            ) : status === ConnectionStatus.CONNECTING ? (
              <svg className="w-10 h-10 text-white animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            ) : (
              <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            )}
          </button>
        </div>
      </main>

      <footer className="p-4 text-center text-teal-700 text-xs border-t border-teal-100 bg-white">
        © 2024 Assistant SVT - Support pédagogique pour les élèves de M. EL OMRANI
      </footer>
    </div>
  );
};

export default App;
