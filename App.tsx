
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameScreen, Player, TargetScore, Question, GameState, GameMessage } from './types';
import { BubbleCard, BubbleButton } from './components/BubbleCard';
import { generateDailyQuestion, checkAnswerSimilarity } from './services/geminiService';
import Peer, { DataConnection } from 'peerjs';

/**
 * KONFIGURASI KONEKSI GLOBAL (STUN + TURN)
 * Sangat penting untuk menghubungkan perangkat di jaringan berbeda (contoh: WiFi vs Data Seluler)
 */
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // Server TURN gratis untuk relay data jika P2P murni diblokir firewall
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
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

  // Selalu sinkronkan Ref dengan State untuk digunakan dalam callback async
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

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

  const handleIncomingData = useCallback(async (data: any, fromConn?: DataConnection) => {
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
      console.log("Menerima Join Request:", msg.name);
      
      const alreadyExist = playersRef.current.find(p => p.id === msg.id);
      if (!alreadyExist && playersRef.current.length < 5) {
        const newPlayerList = [...playersRef.current, { id: msg.id, name: msg.name, score: 0 }];
        setPlayers(newPlayerList);
        // Langsung broadcast daftar pemain baru ke semua orang
        setTimeout(() => broadcastState({ players: newPlayerList }), 200);
      } else if (alreadyExist) {
        // Jika sudah ada, tetap kirim state terbaru untuk konfirmasi
        broadcastState();
      }
    }
    else if (msg.type === 'SUBMIT_ANSWER' && isHost) {
      processAnswer(msg.answer, msg.playerId);
    }
  }, [isHost, broadcastState]);

  const createRoom = () => {
    if (!myPlayerName.trim()) return alert("Masukkan namamu!");
    if (peerRef.current) peerRef.current.destroy();
    
    setIsHost(true);
    setConnStatus('connecting');
    setStatusMsg('Membuka Jalur Server...');
    
    const shortCode = generateShortId();
    const peer = new Peer(shortCode, PEER_CONFIG);
    peerRef.current = peer;

    peer.on('open', (id) => {
      setRoomId(id);
      setPlayers([{ id, name: myPlayerName, score: 0, isHost: true }]);
      setScreen(GameScreen.LOBBY);
      setConnStatus('connected');
      setStatusMsg('');
    });

    peer.on('connection', (conn) => {
      console.log("Koneksi masuk:", conn.peer);
      
      conn.on('open', () => {
        if (!connectionsRef.current.find(c => c.peer === conn.peer)) {
          connectionsRef.current.push(conn);
        }
        // Kirim data awal ke pemain baru agar mereka sinkron layarnya
        setTimeout(() => {
          conn.send({ 
            type: 'STATE_UPDATE', 
            state: { 
              players: playersRef.current, 
              targetScore, 
              currentPlayerIdx, 
              currentQuestion, 
              screen, 
              winner 
            } 
          });
        }, 800);
      });

      conn.on('data', (data) => handleIncomingData(data, conn));
      
      conn.on('close', () => {
        connectionsRef.current = connectionsRef.current.filter(c => c.peer !== conn.peer);
        setPlayers(prev => prev.filter(p => p.id !== conn.peer));
      });
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') createRoom();
      else {
        setConnStatus('error');
        alert("Gagal membuat room. Coba ganti koneksi internet.");
      }
    });
  };

  const joinRoom = () => {
    const code = inputRoomId.trim().toUpperCase();
    if (!code || !myPlayerName.trim()) return alert("Nama dan Kode wajib diisi!");
    
    if (peerRef.current) peerRef.current.destroy();
    
    setIsHost(false);
    setConnStatus('connecting');
    setStatusMsg('Menghubungi Host...');
    
    const peer = new Peer(PEER_CONFIG);
    peerRef.current = peer;

    peer.on('open', (myId) => {
      console.log("ID Anda:", myId);
      const conn = peer.connect(code, { reliable: true });
      
      const connectTimeout = setTimeout(() => {
        if (connStatus !== 'connected' && screen === GameScreen.ENTRY) {
          setConnStatus('error');
          setStatusMsg('Host tidak merespon.');
          alert("Gagal Terhubung. Pastikan Host sudah membuka Room.");
        }
      }, 20000);

      conn.on('open', () => {
        clearTimeout(connectTimeout);
        setConnStatus('connected');
        setStatusMsg('Menunggu Host mendaftarkan anda...');
        connectionsRef.current = [conn];
        
        setRoomId(code);
        setScreen(GameScreen.LOBBY);
        
        // SISTEM HEARTBEAT/RETRY: Kirim permintaan JOIN setiap 1.5 detik
        // sampai Host mengirimkan daftar pemain yang mencantumkan nama kita.
        const knockInterval = setInterval(() => {
          const amIInList = playersRef.current.find(p => p.id === myId);
          if (amIInList || !conn.open || screen !== GameScreen.LOBBY) {
            clearInterval(knockInterval);
            if (amIInList) setStatusMsg('');
          } else {
            console.log("Mencoba mendaftar ke Host...");
            conn.send({ type: 'JOIN_REQUEST', name: myPlayerName, id: myId });
          }
        }, 1500);
      });

      conn.on('data', (data) => handleIncomingData(data));
      conn.on('close', () => {
        setScreen(GameScreen.ENTRY);
        alert("Terputus dari Host.");
      });
    });

    peer.on('error', (err) => {
      setConnStatus('error');
      if (err.type === 'peer-unavailable') {
        alert("Kode Room tidak ditemukan.");
      }
    });
  };

  const startGame = async () => {
    if (players.length < 2) return alert("Minimal 2 pemain!");
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
      if (conn && conn.open) {
        conn.send({ type: 'SUBMIT_ANSWER', answer: userInput, playerId: peerRef.current?.id || '' });
      } else alert("Koneksi terputus!");
    }
    setUserInput('');
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomId);
    setMessage("Kode Berhasil Disalin! ✅");
    setTimeout(() => setMessage(''), 2000);
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
            className="w-full bg-gray-50 border-4 border-gray-100 p-5 rounded-[2rem] text-xl font-bold mb-6 text-center outline-none focus:border-yellow-300"
          />
          <div className="flex flex-col gap-4">
            <BubbleButton onClick={createRoom} disabled={connStatus === 'connecting'} className="text-xl py-4">
              {connStatus === 'connecting' ? 'Connecting...' : 'Buat Room Baru'}
            </BubbleButton>
            <BubbleButton onClick={() => setIsJoining(true)} variant="secondary" className="text-xl py-4">Gabung Room Teman</BubbleButton>
          </div>
          {statusMsg && <p className="mt-4 text-xs text-blue-500 font-bold uppercase tracking-tight">{statusMsg}</p>}
        </BubbleCard>
      )}

      {screen === GameScreen.ENTRY && isJoining && (
        <BubbleCard className="text-center animate-in slide-in-from-right duration-300 relative">
          <button onClick={() => {setIsJoining(false); setStatusMsg(''); setConnStatus('idle');}} className="absolute left-6 top-6 text-gray-400 font-bold text-2xl">←</button>
          <h2 className="text-2xl font-bold text-gray-800 mb-2 mt-4">Gabung Room</h2>
          <p className="text-gray-500 mb-6 italic">Gunakan Kode 5 Digit</p>
          <input
            autoFocus
            type="text"
            maxLength={5}
            value={inputRoomId}
            onChange={(e) => setInputRoomId(e.target.value.toUpperCase())}
            placeholder="KODE"
            className="w-full bg-blue-50 border-4 border-blue-100 p-5 rounded-[2rem] text-4xl font-fredoka mb-6 text-center outline-none uppercase tracking-[0.5em]"
          />
          <BubbleButton onClick={joinRoom} disabled={connStatus === 'connecting'} variant="secondary" className="w-full text-xl py-4">
            {connStatus === 'connecting' ? 'MENYAMBUNG...' : 'GABUNG SEKARANG 🔍'}
          </BubbleButton>
          {statusMsg && <p className="mt-4 text-sm text-blue-500 font-bold animate-pulse">{statusMsg}</p>}
        </BubbleCard>
      )}

      {screen === GameScreen.LOBBY && (
        <BubbleCard className="animate-in fade-in duration-500">
          <div className="text-center mb-8">
            <p className="text-sm font-bold text-gray-400 uppercase tracking-widest">KODE ROOM:</p>
            <div className="flex items-center justify-center gap-3 mt-2 cursor-pointer" onClick={copyRoomCode}>
              <h2 className="text-5xl md:text-6xl font-fredoka text-blue-500 bg-blue-50 py-5 px-10 rounded-3xl border-4 border-blue-200 tracking-wider shadow-inner hover:bg-blue-100 transition-colors">
                {roomId || '...'}
              </h2>
            </div>
            <p className="text-[10px] text-gray-400 mt-2 font-bold uppercase">Klik kode untuk menyalin 📋</p>
          </div>
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-gray-500 mb-4 uppercase text-center">Pemain Terdaftar ({players.length}/5)</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {players.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 bg-gray-50 p-4 rounded-2xl border-2 border-gray-100">
                    <div className="w-10 h-10 bg-yellow-400 rounded-full flex items-center justify-center font-bold text-yellow-900 border-2 border-white shadow-sm">{p.name[0]}</div>
                    <span className="font-bold text-gray-700 truncate">
                      {p.name} {p.isHost && '👑'} 
                      {p.id === peerRef.current?.id && <span className="text-[10px] text-blue-400 ml-2 font-bold">(SAYA)</span>}
                    </span>
                  </div>
                ))}
                {players.length < 2 && !isHost && (
                  <div className="col-span-2 text-center py-4 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
                    <p className="text-xs text-gray-400 font-bold">Sinkronisasi data pemain...</p>
                  </div>
                )}
              </div>
            </div>
            {isHost ? (
              <div className="space-y-4 pt-4 border-t-2 border-gray-50">
                <div className="flex gap-2">
                  {[30, 50, 100].map(s => (
                    <button key={s} onClick={() => setTargetScore(s as TargetScore)} className={`flex-1 p-3 rounded-xl font-bold border-2 transition-all ${targetScore === s ? 'bg-blue-500 text-white border-blue-600 scale-105 shadow-md' : 'bg-white border-gray-100 text-gray-400'}`}>{s} Pts</button>
                  ))}
                </div>
                <BubbleButton onClick={startGame} className="w-full text-xl py-5" disabled={players.length < 2 || isLoading}>MULAI GAME! 🚀</BubbleButton>
                {players.length < 2 && <p className="text-[10px] text-center text-gray-400 font-bold uppercase tracking-widest animate-pulse">Menunggu minimal 1 pemain lagi bergabung...</p>}
              </div>
            ) : (
              <div className="text-center p-8 bg-yellow-50 rounded-[2.5rem] animate-pulse-soft border-4 border-yellow-100">
                <p className="font-bold text-yellow-700 text-lg italic">Menunggu Host Memulai Game...</p>
                {statusMsg && <p className="text-[10px] text-yellow-600 mt-2 font-bold uppercase opacity-60 tracking-widest">{statusMsg}</p>}
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
                <div key={idx} className={`relative h-14 rounded-2xl flex items-center justify-between px-6 font-bold overflow-hidden ${ans.revealed ? 'bg-blue-500 text-white border-blue-600 shadow-md' : 'bg-gray-100 text-gray-300 border-gray-200'} border-2 transition-all duration-500`}>
                  <span className="bg-white bg-opacity-20 w-7 h-7 rounded-full flex items-center justify-center mr-3 text-xs">{idx + 1}</span>
                  <span className="flex-1 truncate uppercase text-sm md:text-base">{ans.revealed ? ans.text : '••••••••••••'}</span>
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
          <h2 className="text-3xl font-fredoka text-gray-800 mb-2">Pemenang!</h2>
          <div className="bg-gradient-to-br from-yellow-400 to-orange-500 text-white p-10 rounded-[3rem] mb-8 inline-block shadow-2xl border-4 border-white">
            <h3 className="text-5xl font-fredoka mb-1">{winner.name}</h3>
            <p className="text-2xl font-bold opacity-90 tracking-widest uppercase">JUARA!</p>
            <p className="text-lg mt-2 bg-black bg-opacity-10 rounded-full py-1 px-4">{winner.score} Poin</p>
          </div>
          <BubbleButton onClick={() => window.location.reload()} variant="primary" className="w-full py-6 text-2xl">MAIN LAGI</BubbleButton>
        </BubbleCard>
      )}

      <footer className="mt-12 text-center text-white opacity-40 text-[10px] font-bold uppercase tracking-widest space-x-4">
        <span>{connStatus === 'connected' ? 'Jaringan Aktif ✅' : 'Masalah Jaringan ❌'}</span>
        <span>•</span>
        <span>ID: {peerRef.current?.id || '-'}</span>
      </footer>
    </div>
  );
};

export default App;
