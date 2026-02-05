
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameScreen, Player, TargetScore, Question, GameState, GameMessage } from './types';
import { BubbleCard, BubbleButton } from './components/BubbleCard';
import { generateDailyQuestion, checkAnswerSimilarity } from './services/geminiService';
import Peer, { DataConnection } from 'peerjs';

/**
 * KONFIGURASI KONEKSI - STABILITAS TINGGI
 */
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10,
  },
  debug: 1
};

const generateShortId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const App: React.FC = () => {
  const [screen, setScreen] = useState<GameScreen>(GameScreen.ENTRY);
  const [isJoining, setIsJoining] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [inputRoomId, setInputRoomId] = useState('');
  const [myPlayerName, setMyPlayerName] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [targetScore, setTargetScore] = useState<TargetScore>(50);
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState(0);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [userInput, setUserInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [connStatus, setConnStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [message, setMessage] = useState('');
  const [winner, setWinner] = useState<Player | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const playersRef = useRef<Player[]>([]);
  const heartbeatIntervalRef = useRef<number | null>(null);

  // Sync state ke ref untuk callback async
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // HANDLE JOIN VIA LINK OTOMATIS
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setInputRoomId(roomFromUrl.toUpperCase());
      setIsJoining(true);
    }
  }, []);

  const broadcastState = useCallback((overrides: Partial<GameState> = {}) => {
    if (!isHost) return;
    const currentState: GameState = {
      players: playersRef.current,
      targetScore,
      currentPlayerIdx,
      currentQuestion,
      screen,
      winner,
      ...overrides
    };
    
    connectionsRef.current.forEach(conn => {
      if (conn.open) {
        try {
          conn.send({ type: 'STATE_UPDATE', state: currentState });
        } catch (e) {
          console.warn("Gagal broadcast ke " + conn.peer);
        }
      }
    });
  }, [isHost, targetScore, currentPlayerIdx, currentQuestion, screen, winner]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    heartbeatIntervalRef.current = window.setInterval(() => {
      if (isHost) {
        connectionsRef.current.forEach(conn => {
          if (conn.open) conn.send({ type: 'PING' });
        });
      } else {
        const hostConn = connectionsRef.current[0];
        if (hostConn && hostConn.open) hostConn.send({ type: 'PONG' });
      }
    }, 4000); // Setiap 4 detik untuk stabilitas seluler
  }, [isHost]);

  const handleIncomingData = useCallback(async (data: any) => {
    if (data.type === 'PING' || data.type === 'PONG') return;
    const msg = data as GameMessage;
    
    if (msg.type === 'STATE_UPDATE') {
      const s = msg.state;
      setPlayers(s.players);
      setTargetScore(s.targetScore);
      setCurrentPlayerIdx(s.currentPlayerIdx);
      setCurrentQuestion(s.currentQuestion);
      setScreen(s.screen);
      setWinner(s.winner);
      setConnStatus('connected');
      setStatusMsg('');
    } 
    else if (msg.type === 'JOIN_REQUEST' && isHost) {
      const alreadyExist = playersRef.current.find(p => p.id === msg.id);
      if (!alreadyExist && playersRef.current.length < 5) {
        const newPlayerList = [...playersRef.current, { id: msg.id, name: msg.name, score: 0 }];
        setPlayers(newPlayerList);
        setTimeout(() => broadcastState({ players: newPlayerList }), 300);
      } else if (alreadyExist) {
        broadcastState();
      }
    }
    else if (msg.type === 'SUBMIT_ANSWER' && isHost) {
      processAnswer(msg.answer, msg.playerId);
    }
  }, [isHost, broadcastState]);

  const createRoom = () => {
    if (!myPlayerName.trim()) return alert("Masukkan namamu dulu!");
    setIsHost(true);
    setConnStatus('connecting');
    setStatusMsg('Membuka Ruangan...');
    
    const shortCode = generateShortId();
    const peer = new Peer(shortCode, PEER_CONFIG);
    peerRef.current = peer;

    peer.on('open', (id) => {
      setRoomId(id);
      setPlayers([{ id, name: myPlayerName, score: 0, isHost: true }]);
      setScreen(GameScreen.LOBBY);
      setConnStatus('connected');
      startHeartbeat();
      // Bersihkan URL agar tidak mengandung room id lama
      window.history.replaceState({}, '', window.location.pathname);
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (!connectionsRef.current.find(c => c.peer === conn.peer)) {
          connectionsRef.current.push(conn);
        }
        setTimeout(() => {
          conn.send({ 
            type: 'STATE_UPDATE', 
            state: { players: playersRef.current, targetScore, currentPlayerIdx, currentQuestion, screen, winner } 
          });
        }, 500);
      });
      conn.on('data', handleIncomingData);
      conn.on('close', () => {
        connectionsRef.current = connectionsRef.current.filter(c => c.peer !== conn.peer);
        setPlayers(prev => prev.filter(p => p.id !== conn.peer));
      });
    });

    peer.on('disconnected', () => peer.reconnect());
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') createRoom();
      else alert("Gagal buat room: " + err.type);
    });
  };

  const joinRoom = () => {
    const code = inputRoomId.trim().toUpperCase();
    if (!code || !myPlayerName.trim()) return alert("Nama dan Kode harus diisi!");
    
    setIsHost(false);
    setConnStatus('connecting');
    setStatusMsg('Menghubungi Host...');
    
    const peer = new Peer(PEER_CONFIG);
    peerRef.current = peer;

    peer.on('open', (myId) => {
      const conn = peer.connect(code, { reliable: true });
      
      const connectTimeout = setTimeout(() => {
        if (connStatus !== 'connected' && screen === GameScreen.ENTRY) {
          setConnStatus('error');
          alert("Host tidak merespon. Pastikan kode benar atau coba lagi.");
        }
      }, 15000);

      conn.on('open', () => {
        clearTimeout(connectTimeout);
        setConnStatus('connected');
        connectionsRef.current = [conn];
        setRoomId(code);
        setScreen(GameScreen.LOBBY);
        startHeartbeat();
        
        const regInterval = setInterval(() => {
          const amIIn = playersRef.current.find(p => p.id === myId);
          if (amIIn || !conn.open || screen !== GameScreen.LOBBY) {
            clearInterval(regInterval);
          } else {
            conn.send({ type: 'JOIN_REQUEST', name: myPlayerName, id: myId });
          }
        }, 1500);
      });

      conn.on('data', handleIncomingData);
      conn.on('close', () => {
        setScreen(GameScreen.ENTRY);
        alert("Koneksi terputus dari Host.");
      });
    });

    peer.on('error', (err) => {
      setConnStatus('error');
      if (err.type === 'peer-unavailable') alert("Room tidak ditemukan.");
    });
  };

  const shareRoomLink = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(url);
    setMessage("Link Undangan Disalin! ✅");
    setTimeout(() => setMessage(''), 2000);
  };

  const startGame = async () => {
    if (players.length < 2) return alert("Butuh minimal 2 pemain!");
    setIsLoading(true);
    const question = await generateDailyQuestion();
    setCurrentQuestion(question);
    setScreen(GameScreen.PLAYING);
    setIsLoading(false);
  };

  const processAnswer = async (answer: string, playerId: string) => {
    if (!currentQuestion || isLoading) return;
    const pIdx = playersRef.current.findIndex(p => p.id === playerId);
    if (pIdx === -1 || pIdx !== currentPlayerIdx) return;

    setIsLoading(true);
    setMessage(`Mengecek jawaban...`);
    const targetAnswers = currentQuestion.answers.map(a => a.text);
    const matchIndex = await checkAnswerSimilarity(answer, targetAnswers);

    if (matchIndex !== null && !currentQuestion.answers[matchIndex].revealed) {
      setPlayers(prev => {
        const newPlayers = [...prev];
        newPlayers[pIdx].score += 5;
        const isWinner = newPlayers[pIdx].score >= targetScore;
        setCurrentQuestion(q => {
          if (!q) return q;
          const newAnswers = [...q.answers];
          newAnswers[matchIndex].revealed = true;
          if (isWinner) {
            setWinner(newPlayers[pIdx]);
            setScreen(GameScreen.WINNER);
          } else if (newAnswers.every(a => a.revealed)) {
            setMessage('🎉 SEMUA TERJAWAB!');
            setTimeout(async () => {
              const nextQ = await generateDailyQuestion();
              setCurrentQuestion(nextQ);
              setCurrentPlayerIdx(cur => (cur + 1) % newPlayers.length);
              setMessage('');
            }, 2000);
          } else {
            setMessage('🎉 TEPAT SEKALI!');
            setTimeout(() => setMessage(''), 2000);
          }
          return { ...q, answers: newAnswers };
        });
        return newPlayers;
      });
    } else {
      setMessage('❌ Salah!');
      setTimeout(() => {
        setCurrentPlayerIdx(prev => (prev + 1) % playersRef.current.length);
        setMessage('');
      }, 2000);
    }
    setIsLoading(false);
  };

  const handleClientSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim() || isLoading) return;
    if (isHost) processAnswer(userInput, peerRef.current?.id || '');
    else {
      const conn = connectionsRef.current[0];
      if (conn && conn.open) conn.send({ type: 'SUBMIT_ANSWER', answer: userInput, playerId: peerRef.current?.id || '' });
    }
    setUserInput('');
  };

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8 min-h-screen flex flex-col justify-center">
      <header className="text-center mb-8">
        <h1 className="text-5xl md:text-7xl font-fredoka text-white drop-shadow-lg animate-bounce">Family 100</h1>
        <p className="text-white font-bold tracking-widest mt-2 uppercase opacity-80">Online Multiplayer</p>
      </header>

      {screen === GameScreen.ENTRY && !isJoining && (
        <BubbleCard className="text-center animate-in zoom-in duration-300">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">Siapa namamu?</h2>
          <input
            type="text"
            value={myPlayerName}
            onChange={(e) => setMyPlayerName(e.target.value)}
            placeholder="Ketik namamu..."
            className="w-full bg-gray-50 border-4 border-gray-100 p-5 rounded-[2rem] text-xl font-bold mb-6 text-center outline-none focus:border-yellow-300 shadow-inner"
          />
          <div className="flex flex-col gap-4">
            <BubbleButton onClick={createRoom} disabled={connStatus === 'connecting'} className="text-xl py-4">
              {connStatus === 'connecting' ? 'Loading...' : 'Buat Room Baru'}
            </BubbleButton>
            <BubbleButton onClick={() => setIsJoining(true)} variant="secondary" className="text-xl py-4">Gabung Room Teman</BubbleButton>
          </div>
        </BubbleCard>
      )}

      {screen === GameScreen.ENTRY && isJoining && (
        <BubbleCard className="text-center animate-in slide-in-from-right duration-300 relative">
          <button onClick={() => {setIsJoining(false); setConnStatus('idle');}} className="absolute left-6 top-6 text-gray-400 font-bold text-2xl hover:text-gray-600">←</button>
          <h2 className="text-2xl font-bold text-gray-800 mb-2 mt-4">Gabung Room</h2>
          <p className="text-gray-500 mb-6 italic">Masukkan Kode atau Nama Anda</p>
          <div className="space-y-4">
            <input
              type="text"
              value={myPlayerName}
              onChange={(e) => setMyPlayerName(e.target.value)}
              placeholder="Namamu..."
              className="w-full bg-gray-50 border-4 border-gray-100 p-4 rounded-2xl text-lg font-bold text-center outline-none focus:border-blue-300"
            />
            <input
              autoFocus
              type="text"
              maxLength={5}
              value={inputRoomId}
              onChange={(e) => setInputRoomId(e.target.value.toUpperCase())}
              placeholder="KODE"
              className="w-full bg-blue-50 border-4 border-blue-100 p-5 rounded-[2rem] text-4xl font-fredoka text-center outline-none uppercase tracking-[0.5em] shadow-inner"
            />
          </div>
          <BubbleButton onClick={joinRoom} disabled={connStatus === 'connecting'} variant="secondary" className="w-full text-xl py-4 mt-6">
            {connStatus === 'connecting' ? 'MENYAMBUNG...' : 'GABUNG SEKARANG 🔍'}
          </BubbleButton>
          {statusMsg && <p className="mt-4 text-sm text-blue-500 font-bold animate-pulse">{statusMsg}</p>}
        </BubbleCard>
      )}

      {screen === GameScreen.LOBBY && (
        <BubbleCard className="animate-in fade-in duration-500">
          <div className="text-center mb-8">
            <p className="text-sm font-bold text-gray-400 uppercase tracking-widest">KODE ROOM:</p>
            <h2 className="text-5xl md:text-6xl font-fredoka text-blue-500 bg-blue-50 py-5 px-10 rounded-3xl border-4 border-blue-200 tracking-wider shadow-inner inline-block mt-2">
              {roomId || '...'}
            </h2>
            <div className="flex gap-2 justify-center mt-4">
              <BubbleButton onClick={shareRoomLink} variant="secondary" className="text-sm py-2">Bagikan Link Undangan 🔗</BubbleButton>
            </div>
          </div>
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-gray-500 mb-4 uppercase text-center">Pemain ({players.length}/5)</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {players.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 bg-white p-4 rounded-2xl border-2 border-gray-100 shadow-sm animate-in zoom-in duration-300">
                    <div className="w-10 h-10 bg-yellow-400 rounded-full flex items-center justify-center font-bold text-yellow-900 border-2 border-white shadow-sm">{p.name[0]}</div>
                    <span className="font-bold text-gray-700 truncate flex-1">
                      {p.name} {p.isHost && '👑'} 
                    </span>
                    {p.id === peerRef.current?.id && <span className="text-[9px] bg-blue-100 text-blue-600 px-2 py-1 rounded-full font-bold uppercase tracking-tight">Saya</span>}
                  </div>
                ))}
              </div>
            </div>
            {isHost ? (
              <div className="space-y-4 pt-4 border-t-2 border-gray-50">
                <p className="text-xs font-bold text-gray-400 text-center uppercase">Target Skor:</p>
                <div className="flex gap-2">
                  {[30, 50, 100].map(s => (
                    <button key={s} onClick={() => setTargetScore(s as TargetScore)} className={`flex-1 p-3 rounded-xl font-bold border-2 transition-all ${targetScore === s ? 'bg-blue-500 text-white border-blue-600 scale-105 shadow-md' : 'bg-white border-gray-100 text-gray-400 hover:bg-gray-50'}`}>{s} Pts</button>
                  ))}
                </div>
                <BubbleButton onClick={startGame} className="w-full text-xl py-5" disabled={players.length < 2 || isLoading}>MULAI GAME! 🚀</BubbleButton>
                {players.length < 2 && <p className="text-[10px] text-center text-gray-400 font-bold uppercase tracking-widest animate-pulse">Menunggu minimal 1 teman lagi...</p>}
              </div>
            ) : (
              <div className="text-center p-8 bg-yellow-50 rounded-[2.5rem] animate-pulse-soft border-4 border-yellow-100">
                <p className="font-bold text-yellow-700 text-lg italic">Menunggu Host Memulai...</p>
                <p className="text-[10px] text-yellow-600 mt-2 font-bold uppercase opacity-60 tracking-widest">Koneksi Stabil ✅</p>
              </div>
            )}
            {message && <p className="text-center text-green-500 font-bold text-sm animate-bounce">{message}</p>}
          </div>
        </BubbleCard>
      )}

      {screen === GameScreen.PLAYING && currentQuestion && (
        <div className="space-y-6 animate-in slide-in-from-bottom duration-500">
          <div className="flex flex-wrap gap-2 justify-center">
            {players.map((p, i) => (
              <div key={p.id} className={`p-3 rounded-[1.5rem] border-4 transition-all flex flex-col items-center min-w-[100px] ${currentPlayerIdx === i ? 'bg-yellow-100 border-yellow-400 scale-105 shadow-lg z-10' : 'bg-white opacity-60 border-white'}`}>
                <span className="font-fredoka text-base truncate w-full text-center text-gray-800">{p.name}</span>
                <span className="bg-white px-3 py-1 rounded-full text-xs font-bold mt-1 text-blue-600 shadow-sm">{p.score} pts</span>
              </div>
            ))}
          </div>
          <BubbleCard>
            <div className="text-center mb-6"><p className="text-gray-800 text-xl md:text-3xl font-bold leading-tight px-2">"{currentQuestion.prompt}"</p></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
              {currentQuestion.answers.map((ans, idx) => (
                <div key={idx} className={`relative h-14 rounded-2xl flex items-center justify-between px-6 font-bold overflow-hidden ${ans.revealed ? 'bg-blue-500 text-white border-blue-600 shadow-md' : 'bg-gray-100 text-gray-300 border-gray-200'} border-2 transition-all duration-500 shadow-sm`}>
                  <span className="bg-white bg-opacity-20 w-7 h-7 rounded-full flex items-center justify-center mr-3 text-xs">{idx + 1}</span>
                  <span className="flex-1 truncate uppercase text-sm md:text-base tracking-wide">{ans.revealed ? ans.text : '••••••••••••'}</span>
                </div>
              ))}
            </div>
            {players[currentPlayerIdx]?.id === peerRef.current?.id ? (
              <form onSubmit={handleClientSubmit} className="relative">
                <input autoFocus disabled={isLoading} value={userInput} onChange={(e) => setUserInput(e.target.value)} placeholder="Ketik jawabanmu..." className="w-full bg-yellow-50 border-4 border-yellow-200 p-5 rounded-[2rem] text-xl font-bold text-gray-700 outline-none shadow-inner" />
                <div className="absolute right-2 top-2 bottom-2"><BubbleButton disabled={isLoading} className="h-full px-8 py-0">KIRIM</BubbleButton></div>
              </form>
            ) : (
              <div className="text-center p-6 bg-gray-50 rounded-[2rem] border-4 border-dashed border-gray-200"><p className="text-gray-400 font-bold italic text-lg">Giliran <span className="text-gray-600 font-fredoka">{players[currentPlayerIdx]?.name}</span> menjawab...</p></div>
            )}
            {message && <div className="mt-4 text-center font-bold text-lg text-blue-600 animate-bounce">{message}</div>}
          </BubbleCard>
        </div>
      )}

      {screen === GameScreen.WINNER && winner && (
        <BubbleCard className="text-center animate-in zoom-in duration-500">
          <div className="text-8xl mb-4">🏆</div>
          <h2 className="text-3xl font-fredoka text-gray-800 mb-2">Horeee!</h2>
          <div className="bg-gradient-to-br from-yellow-400 to-orange-500 text-white p-10 rounded-[3rem] mb-8 inline-block shadow-2xl border-4 border-white">
            <h3 className="text-5xl font-fredoka mb-1">{winner.name}</h3>
            <p className="text-2xl font-bold opacity-90 tracking-widest uppercase">PEMENANG!</p>
            <p className="text-lg mt-2 bg-black bg-opacity-10 rounded-full py-1 px-4">{winner.score} Poin</p>
          </div>
          <BubbleButton onClick={() => window.location.replace(window.location.origin)} variant="primary" className="w-full py-6 text-2xl">MAIN LAGI</BubbleButton>
        </BubbleCard>
      )}

      <footer className="mt-12 text-center text-white opacity-40 text-[10px] font-bold uppercase tracking-widest space-x-4">
        <span>{connStatus === 'connected' ? 'Jaringan Aktif ✅' : 'Mencari Jaringan...'}</span>
        <span>•</span>
        <span>Family 100 Online</span>
      </footer>
    </div>
  );
};

export default App;
