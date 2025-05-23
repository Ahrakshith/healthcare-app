// src/components/DoctorChat.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, onSnapshot, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';
import io from 'socket.io-client';
import { transcribeAudio, translateText, textToSpeechConvert } from '../services/speech.js';

function DoctorChat({ user, role, handleLogout }) {
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [selectedPatientName, setSelectedPatientName] = useState('');
  const [patients, setPatients] = useState([]);
  const [messages, setMessages] = useState([]);
  const [missedDoseAlerts, setMissedDoseAlerts] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [prescription, setPrescription] = useState({
    medicine: '',
    dosage: '',
    frequency: '',
    duration: '',
  });
  const [error, setError] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [diagnosisPrompt, setDiagnosisPrompt] = useState(null);
  const [doctorId, setDoctorId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [languagePreference, setLanguagePreference] = useState('en');
  const [menuOpen, setMenuOpen] = useState(false);
  const [doctorProfile, setDoctorProfile] = useState(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState('');
  const audioRef = useRef(new Audio());
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const navigate = useNavigate();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Fetch Doctor ID
  useEffect(() => {
    if (role !== 'doctor' || !user?.uid) {
      setError('Unauthorized access. Redirecting to login.');
      navigate('/login');
      return;
    }

    const fetchDoctorId = async () => {
      try {
        const q = query(collection(db, 'doctors'), where('uid', '==', user.uid));
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
          setError('Doctor profile not found.');
          setLoadingPatients(false);
          return;
        }
        const doctorDoc = querySnapshot.docs[0];
        const doctorData = doctorDoc.data();
        setDoctorId(doctorData.doctorId);
        setDoctorProfile({
          name: doctorData.name || 'N/A',
          doctorId: doctorData.doctorId || 'N/A',
          email: doctorData.email || 'N/A',
        });
      } catch (err) {
        setError('Failed to fetch doctor profile: ' + err.message);
        setLoadingPatients(false);
      }
    };

    fetchDoctorId();
  }, [role, navigate, user?.uid]);

  // Fetch Patients
  useEffect(() => {
    if (!doctorId) return;

    setLoadingPatients(true);
    const q = query(collection(db, 'doctor_assignments'), where('doctorId', '==', doctorId));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const assignedPatients = snapshot.docs.map((doc) => ({
          patientId: doc.data().patientId,
          doctorId: doc.data().doctorId,
          timestamp: doc.data().timestamp,
          patientName: doc.data().patientName || `Patient ${doc.data().patientId}`,
          age: doc.data().age || 'N/A',
          sex: doc.data().sex || 'N/A',
        }));
        setPatients(assignedPatients);
        setLoadingPatients(false);
        if (!selectedPatientId && assignedPatients.length > 0) {
          setSelectedPatientId(assignedPatients[0].patientId);
          setSelectedPatientName(assignedPatients[0].patientName);
        }
      },
      (err) => {
        setError('Failed to fetch patients: ' + err.message);
        setLoadingPatients(false);
      }
    );

    return () => unsubscribe();
  }, [doctorId, selectedPatientId]);

  // WebSocket and Data Fetching
  useEffect(() => {
    if (!selectedPatientId || !user?.uid || !doctorId) {
      return;
    }

    socketRef.current = io('http://localhost:5005', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    const roomName = `${selectedPatientId}-${doctorId}`;
    socketRef.current.on('connect', () => {
      socketRef.current.emit('joinRoom', roomName);
    });

    socketRef.current.on('newMessage', (message) => {
      setMessages((prev) => {
        if (!prev.some((msg) => msg.timestamp === message.timestamp)) {
          return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }
        return prev;
      });

      // Check if prompt is needed after new patient message
      if (message.sender === 'patient') {
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        const hoursSinceLast = lastMessage
          ? (new Date() - new Date(lastMessage.timestamp)) / (1000 * 60 * 60)
          : Infinity;
        const patientAssignment = patients.find((p) => p.patientId === selectedPatientId);
        const hoursSinceAssignment = patientAssignment
          ? (new Date() - new Date(patientAssignment.timestamp)) / (1000 * 60 * 60)
          : Infinity;
        if (hoursSinceAssignment <= 24 || hoursSinceLast >= 168) {
          setDiagnosisPrompt(selectedPatientId);
        }
      }
    });

    socketRef.current.on('missedDoseAlert', (alert) => {
      if (alert.patientId === selectedPatientId) {
        setMissedDoseAlerts((prev) => [...prev, { ...alert, id: Date.now().toString() }]);
      }
    });

    const fetchMessages = async () => {
      setLoadingMessages(true);
      try {
        const response = await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
          headers: { 'x-user-uid': user.uid },
          credentials: 'include',
        });
        if (!response.ok) {
          if (response.status === 404) {
            setMessages([]);
            const patientAssignment = patients.find((p) => p.patientId === selectedPatientId);
            const hoursSinceAssignment = patientAssignment
              ? (new Date() - new Date(patientAssignment.timestamp)) / (1000 * 60 * 60)
              : Infinity;
            if (hoursSinceAssignment <= 24) {
              setDiagnosisPrompt(selectedPatientId);
            }
            return;
          }
          throw new Error(`Failed to fetch messages: ${response.statusText}`);
        }
        const data = await response.json();
        const validatedMessages = await Promise.all(
          data.messages.map(async (msg) => {
            const updatedMsg = { ...msg };
            if (msg.audioUrl) {
              try {
                const response = await fetch(msg.audioUrl, { method: 'HEAD' });
                if (!response.ok) updatedMsg.audioUrl = null;
              } catch {
                updatedMsg.audioUrl = null;
              }
            }
            if (msg.audioUrlEn) {
              try {
                const response = await fetch(msg.audioUrlEn, { method: 'HEAD' });
                if (!response.ok) updatedMsg.audioUrlEn = null;
              } catch {
                updatedMsg.audioUrlEn = null;
              }
            }
            if (msg.audioUrlKn) {
              try {
                const response = await fetch(msg.audioUrlKn, { method: 'HEAD' });
                if (!response.ok) updatedMsg.audioUrlKn = null;
              } catch {
                updatedMsg.audioUrlKn = null;
              }
            }
            return updatedMsg;
          })
        );
        setMessages(validatedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
        const lastMessage = validatedMessages.length > 0 ? validatedMessages[validatedMessages.length - 1] : null;
        const hoursSinceLast = lastMessage
          ? (new Date() - new Date(lastMessage.timestamp)) / (1000 * 60 * 60)
          : Infinity;
        const patientAssignment = patients.find((p) => p.patientId === selectedPatientId);
        const hoursSinceAssignment = patientAssignment
          ? (new Date() - new Date(patientAssignment.timestamp)) / (1000 * 60 * 60)
          : Infinity;
        if (hoursSinceAssignment <= 24 || hoursSinceLast >= 168) {
          setDiagnosisPrompt(selectedPatientId);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingMessages(false);
      }
    };

    const fetchLanguagePreference = async () => {
      try {
        const patientRef = doc(db, 'patients', selectedPatientId);
        const patientDoc = await getDoc(patientRef);
        setLanguagePreference(patientDoc.exists() ? patientDoc.data().languagePreference || 'en' : 'en');
      } catch (err) {
        setError(`Failed to fetch language preference: ${err.message}`);
      }
    };

    const fetchMissedDoseAlerts = async () => {
      try {
        const response = await fetch('http://localhost:5005/admin_notifications', {
          headers: { 'x-user-uid': user.uid },
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Failed to fetch alerts');
        const notifications = await response.json();
        setMissedDoseAlerts(
          notifications
            .filter((n) => n.patientId === selectedPatientId)
            .map((n) => ({ ...n, id: n.id || Date.now().toString() }))
        );
      } catch (err) {
        setError(`Failed to fetch alerts: ${err.message}`);
      }
    };

    fetchMessages();
    fetchLanguagePreference();
    fetchMissedDoseAlerts();

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [selectedPatientId, user?.uid, doctorId, patients]);

  const handleDiagnosisDecision = async (accept) => {
    if (!selectedPatientId) {
      setError('No patient selected.');
      return;
    }
    if (accept) {
      setDiagnosisPrompt(null);
    } else {
      const message = {
        sender: 'doctor',
        text: 'Sorry, I am not available at the moment. Please chat with another doctor.',
        translatedText:
          languagePreference === 'kn'
            ? await translateText('Sorry, I am not available at the moment. Please chat with another doctor.', 'en', 'kn')
            : null,
        language: 'en',
        recordingLanguage: 'en',
        timestamp: new Date().toISOString(),
        doctorId,
        patientId: selectedPatientId,
      };
      try {
        await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
          body: JSON.stringify(message),
          credentials: 'include',
        });
        socketRef.current.emit('newMessage', message);
        setPatients((prev) => prev.filter((p) => p.patientId !== selectedPatientId));
        setSelectedPatientId(null);
        setSelectedPatientName('');
        setDiagnosisPrompt(null);
      } catch (err) {
        setError('Failed to send message: ' + err.message);
      }
    }
  };

  const startRecording = async () => {
    if (!selectedPatientId) {
      setError('No patient selected.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      setMediaRecorder(recorder);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && audioChunksRef.current.push(e.data);
      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size === 0) {
          setError('Empty audio recorded.');
          return;
        }
        try {
          const transcriptionResult = await transcribeAudio(audioBlob, 'en-US', user.uid);
          const transcribedText = transcriptionResult.transcription || 'Transcription failed';
          let translatedText = null;
          let audioUrl = transcriptionResult.audioUrl;
          let audioUrlEn = await textToSpeechConvert(transcribedText, 'en-US');
          let audioUrlKn = null;

          if (languagePreference === 'kn') {
            translatedText = await translateText(transcribedText, 'en', 'kn');
            audioUrlKn = await textToSpeechConvert(translatedText, 'kn-IN');
          }

          const message = {
            sender: 'doctor',
            text: transcribedText,
            translatedText,
            language: 'en',
            recordingLanguage: 'en',
            audioUrl,
            audioUrlEn,
            audioUrlKn,
            timestamp: new Date().toISOString(),
            doctorId,
            patientId: selectedPatientId,
          };
          await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
            body: JSON.stringify(message),
            credentials: 'include',
          });
          socketRef.current.emit('newMessage', message);
          setMessages((prev) => [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
        } catch (err) {
          setError(`Failed to process audio: ${err.message}`);
        }
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(`Recording error: ${err.message}`);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || !selectedPatientId || !user?.uid || !doctorId) {
      setError('Please type a message and ensure a patient is selected.');
      return;
    }
    try {
      let translatedText = null;
      let audioUrlEn = await textToSpeechConvert(newMessage, 'en-US');
      let audioUrlKn = null;

      if (languagePreference === 'kn') {
        translatedText = await translateText(newMessage, 'en', 'kn');
        audioUrlKn = await textToSpeechConvert(translatedText, 'kn-IN');
      }

      const message = {
        sender: 'doctor',
        text: newMessage,
        translatedText,
        language: 'en',
        recordingLanguage: 'en',
        audioUrl: null,
        audioUrlEn,
        audioUrlKn,
        timestamp: new Date().toISOString(),
        doctorId,
        patientId: selectedPatientId,
      };
      await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify(message),
        credentials: 'include',
      });
      socketRef.current.emit('newMessage', message);
      setMessages((prev) => [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      setNewMessage('');
    } catch (err) {
      setError('Failed to send message: ' + err.message);
    }
  };

  const sendDiagnosis = async () => {
    if (!diagnosis.trim()) {
      setError('Please enter a diagnosis.');
      return;
    }
    if (!selectedPatientId) {
      setError('No patient selected.');
      return;
    }
    const message = {
      sender: 'doctor',
      diagnosis,
      timestamp: new Date().toISOString(),
      doctorId,
      patientId: selectedPatientId,
    };
    try {
      await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify(message),
        credentials: 'include',
      });
      socketRef.current.emit('newMessage', message);
      setMessages((prev) => [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      await fetch(`http://localhost:5005/patients/${selectedPatientId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify({ diagnosis, doctorId }),
        credentials: 'include',
      });
      const selectedPatient = patients.find((p) => p.patientId === selectedPatientId);
      await fetch('http://localhost:5005/admin_notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify({
          patientId: selectedPatientId,
          patientName: selectedPatientName,
          age: selectedPatient?.age || 'N/A',
          sex: selectedPatient?.sex || 'N/A',
          description: 'N/A',
          disease: diagnosis,
          medicine: undefined,
          doctorId,
        }),
        credentials: 'include',
      });
      setDiagnosis('');
      setShowActionModal(false);
    } catch (err) {
      setError('Failed to send diagnosis: ' + err.message);
    }
  };

  const sendPrescription = async () => {
    const { medicine, dosage, frequency, duration } = prescription;
    if (!medicine.trim() || !dosage.trim() || !frequency.trim() || !duration.trim()) {
      setError('Please fill all prescription fields.');
      return;
    }
    if (!selectedPatientId) {
      setError('No patient selected.');
      return;
    }
    const latestDiagnosisMessage = messages
      .filter((msg) => msg.sender === 'doctor' && msg.diagnosis)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!latestDiagnosisMessage) {
      setError('Provide a diagnosis first.');
      return;
    }
    const prescriptionString = `${medicine}, ${dosage}, ${frequency}, ${duration}`;
    const message = {
      sender: 'doctor',
      prescription: { medicine, dosage, frequency, duration },
      timestamp: new Date().toISOString(),
      doctorId,
      patientId: selectedPatientId,
    };
    try {
      await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify(message),
        credentials: 'include',
      });
      socketRef.current.emit('newMessage', message);
      setMessages((prev) => [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      await fetch(`http://localhost:5005/patients/${selectedPatientId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify({ prescription: prescriptionString, doctorId }),
        credentials: 'include',
      });
      const selectedPatient = patients.find((p) => p.patientId === selectedPatientId);
      await fetch('http://localhost:5005/admin_notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify({
          patientId: selectedPatientId,
          patientName: selectedPatientName,
          age: selectedPatient?.age || 'N/A',
          sex: selectedPatient?.sex || 'N/A',
          description: 'N/A',
          disease: latestDiagnosisMessage.diagnosis,
          medicine: prescriptionString,
          doctorId,
        }),
        credentials: 'include',
      });
      setPrescription({ medicine: '', dosage: '', frequency: '', duration: '' });
      setShowActionModal(false);
    } catch (err) {
      setError('Failed to send prescription: ' + err.message);
    }
  };

  const readAloud = async (text, lang, audioUrl) => {
    try {
      if (!text && !audioUrl) {
        setError('No valid text or audio provided.');
        return;
      }
      const audioToPlay = audioUrl || (await textToSpeechConvert(text.trim(), lang === 'kn' ? 'kn-IN' : 'en-US'));
      audioRef.current.src = audioToPlay;
      audioRef.current.play();
    } catch (err) {
      setError(`Error reading aloud: ${err.message}`);
    }
  };

  const dismissAlert = (alertId) => {
    setMissedDoseAlerts((prev) => prev.filter((alert) => alert.id !== alertId));
  };

  const isValidPrescription = (prescription) => {
    return (
      prescription &&
      prescription.medicine &&
      prescription.dosage &&
      prescription.frequency &&
      prescription.duration
    );
  };

  return (
    <div className="doctor-chat-container">
      <div className="chat-header">
        <button className="hamburger-button" onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <h2>{selectedPatientId ? `Chat with ${selectedPatientName}` : 'Doctor Dashboard'}</h2>
        <div className="header-actions">
          <button onClick={handleLogout} className="logout-button">
            Logout
          </button>
        </div>
      </div>
      <div className="chat-layout">
        <div className={`patient-sidebar ${menuOpen ? 'open' : ''}`}>
          <div className="sidebar-header">
            <h3>Assigned Patients</h3>
            <button className="close-menu" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
          </div>
          {loadingPatients ? (
            <p className="loading-text">Loading...</p>
          ) : patients.length === 0 ? (
            <p className="no-patients">No patients assigned.</p>
          ) : (
            <ul className="patient-list">
              {patients.map((patient) => (
                <li
                  key={patient.patientId}
                  className={`patient-item ${selectedPatientId === patient.patientId ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedPatientId(patient.patientId);
                    setSelectedPatientName(patient.patientName);
                    setMissedDoseAlerts([]);
                    setMenuOpen(false);
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Select patient ${patient.patientName}`}
                >
                  <span>{patient.patientName}</span>
                  <small>{new Date(patient.timestamp).toLocaleDateString()}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="chat-content">
          {doctorProfile && (
            <div className="doctor-profile">
              <h3>Doctor Profile</h3>
              <p><strong>Name:</strong> {doctorProfile.name}</p>
              <p><strong>Doctor ID:</strong> {doctorProfile.doctorId}</p>
              <p><strong>Email:</strong> {doctorProfile.email}</p>
              <button onClick={() => setDoctorProfile(null)} className="close-section-button">
                Close
              </button>
            </div>
          )}
          {selectedPatientId ? (
            diagnosisPrompt === selectedPatientId ? (
              <div className="diagnosis-prompt">
                <h3>Chat with {selectedPatientName}</h3>
                <p>
                  {(() => {
                    const patientAssignment = patients.find((p) => p.patientId === selectedPatientId);
                    const hoursSinceAssignment = patientAssignment
                      ? (new Date() - new Date(patientAssignment.timestamp)) / (1000 * 60 * 60)
                      : Infinity;
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    const hoursSinceLast = lastMessage
                      ? (new Date() - new Date(lastMessage.timestamp)) / (1000 * 60 * 60)
                      : Infinity;
                    if (hoursSinceAssignment <= 24) return 'New patient (within 24 hours). ';
                    if (hoursSinceLast >= 168) return 'Last chat over 7 days ago. ';
                    return '';
                  })()}
                  Chat now?
                </p>
                <div className="prompt-buttons">
                  <button onClick={() => handleDiagnosisDecision(true)} className="accept-button">
                    Yes
                  </button>
                  <button onClick={() => handleDiagnosisDecision(false)} className="decline-button">
                    No
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-main">
                {missedDoseAlerts.length > 0 && (
                  <div className="missed-dose-alerts">
                    <h3>Missed Dose Alerts</h3>
                    {missedDoseAlerts.map((alert) => (
                      <div key={alert.id} className="alert-item">
                        <p>{alert.message || `Patient missed doses.`}</p>
                        <button onClick={() => dismissAlert(alert.id)} className="dismiss-button">
                          Dismiss
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="messages-container">
                  {loadingMessages ? (
                    <p className="loading-text">Loading messages...</p>
                  ) : messages.length === 0 ? (
                    <p className="no-messages">No messages yet.</p>
                  ) : (
                    messages.map((msg, index) => (
                      <div
                        key={index}
                        className={`message ${msg.sender === 'doctor' ? 'doctor-message' : 'patient-message'}`}
                      >
                        <div className="message-content">
                          {msg.sender === 'patient' && (
                            <>
                              {(msg.recordingLanguage || msg.language) === 'en' ? (
                                <>
                                  <p>{msg.text || 'No transcription'}</p>
                                  {msg.audioUrl && (
                                    <div className="audio-container">
                                      <audio controls src={msg.audioUrl} />
                                      <a href={msg.audioUrl} download className="download-link">
                                        Download Audio
                                      </a>
                                    </div>
                                  )}
                                  {msg.audioUrlEn && (
                                    <div className="read-aloud-buttons">
                                      <button
                                        onClick={() => readAloud(null, 'en', msg.audioUrlEn)}
                                        className="read-aloud-button"
                                      >
                                        🔊 (English)
                                      </button>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p>{msg.text || 'No transcription'}</p>
                                  {msg.translatedText && (
                                    <p className="translated-text">(English: {msg.translatedText})</p>
                                  )}
                                  {msg.audioUrl && (
                                    <div className="audio-container">
                                      <audio controls src={msg.audioUrl} />
                                      <a href={msg.audioUrl} download className="download-link">
                                        Download Audio
                                      </a>
                                    </div>
                                  )}
                                  {(msg.audioUrlEn || msg.audioUrlKn) && (
                                    <div className="read-aloud-buttons">
                                      {msg.audioUrlKn && (
                                        <button
                                          onClick={() => readAloud(null, 'kn', msg.audioUrlKn)}
                                          className="read-aloud-button"
                                        >
                                          🔊 (Kannada)
                                        </button>
                                      )}
                                      {msg.audioUrlEn && (
                                        <button
                                          onClick={() => readAloud(null, 'en', msg.audioUrlEn)}
                                          className="read-aloud-button"
                                        >
                                          🔊 (English)
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          )}
                          {msg.sender === 'doctor' && (
                            <>
                              {msg.text && (
                                <>
                                  {languagePreference === 'en' ? (
                                    <>
                                      <p>{msg.text}</p>
                                      {msg.audioUrl && (
                                        <div className="audio-container">
                                          <audio controls src={msg.audioUrl} />
                                          <a href={msg.audioUrl} download className="download-link">
                                            Download Audio
                                          </a>
                                        </div>
                                      )}
                                      {msg.audioUrlEn && (
                                        <div className="read-aloud-buttons">
                                          <button
                                            onClick={() => readAloud(null, 'en', msg.audioUrlEn)}
                                            className="read-aloud-button"
                                          >
                                            🔊 (English)
                                          </button>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <p>{msg.translatedText || msg.text}</p>
                                      {msg.text && <p className="translated-text">(English: {msg.text})</p>}
                                      {msg.audioUrl && (
                                        <div className="audio-container">
                                          <audio controls src={msg.audioUrl} />
                                          <a href={msg.audioUrl} download className="download-link">
                                            Download Audio
                                          </a>
                                        </div>
                                      )}
                                      {(msg.audioUrlEn || msg.audioUrlKn) && (
                                        <div className="read-aloud-buttons">
                                          {msg.audioUrlKn && (
                                            <button
                                              onClick={() => readAloud(null, 'kn', msg.audioUrlKn)}
                                              className="read-aloud-button"
                                            >
                                              🔊 (Kannada)
                                            </button>
                                          )}
                                          {msg.audioUrlEn && (
                                            <button
                                              onClick={() => readAloud(null, 'en', msg.audioUrlEn)}
                                              className="read-aloud-button"
                                            >
                                              🔊 (English)
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </>
                              )}
                              {msg.diagnosis && (
                                <div className="recommendation-item">
                                  <strong>Diagnosis:</strong> {msg.diagnosis}
                                  <button
                                    onClick={() => readAloud(msg.diagnosis, 'en', null)}
                                    className="read-aloud-button"
                                  >
                                    🔊
                                  </button>
                                </div>
                              )}
                              {msg.prescription && isValidPrescription(msg.prescription) && (
                                <div className="recommendation-item">
                                  <strong>Prescription:</strong>{' '}
                                  {`${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`}
                                </div>
                              )}
                            </>
                          )}
                          <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>
                {error && <div className="error-message">{error}</div>}
                <div className="controls">
                  <div className="recording-buttons">
                    <button
                      onClick={startRecording}
                      disabled={recording}
                      className={recording ? 'disabled-button' : 'start-button'}
                    >
                      🎙️ Record
                    </button>
                    <button
                      onClick={stopRecording}
                      disabled={!recording}
                      className={!recording ? 'disabled-button' : 'stop-button'}
                    >
                      🛑 Stop
                    </button>
                    <button
                      onClick={() => setShowActionModal(true)}
                      className="action-button"
                    >
                      ⚕️ Diagnosis/Prescription
                    </button>
                  </div>
                  <div className="text-input-container">
                    <input
                      type="text"
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      placeholder="Type a message (English only)..."
                      onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                    />
                    <button onClick={sendMessage} className="send-button">
                      Send
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="no-patient-selected">
              <p>Select a patient to start chatting.</p>
            </div>
          )}
        </div>
      </div>
      {showActionModal && (
        <div className="action-modal">
          <div className="modal-content">
            <h3>{actionType === 'Diagnosis' ? 'Provide Diagnosis' : actionType === 'Prescription' ? 'Prescribe Medicine' : 'Select an Action'}</h3>
            <select
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              aria-label="Select action type"
            >
              <option value="">Select an action...</option>
              <option value="Diagnosis">Diagnosis</option>
              <option value="Prescription">Prescription</option>
            </select>
            {actionType === 'Diagnosis' && (
              <>
                <textarea
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder="Enter diagnosis..."
                />
                <button onClick={sendDiagnosis} className="submit-button">
                  Send Diagnosis
                </button>
              </>
            )}
            {actionType === 'Prescription' && (
              <>
                <input
                  type="text"
                  value={prescription.medicine}
                  onChange={(e) => setPrescription({ ...prescription, medicine: e.target.value })}
                  placeholder="Medicine (e.g., Paracetamol)"
                />
                <input
                  type="text"
                  value={prescription.dosage}
                  onChange={(e) => setPrescription({ ...prescription, dosage: e.target.value })}
                  placeholder="Dosage (e.g., 500mg)"
                />
                <input
                  type="text"
                  value={prescription.frequency}
                  onChange={(e) => setPrescription({ ...prescription, frequency: e.target.value })}
                  placeholder="Frequency (e.g., 08:00 AM and 06:00 PM)"
                />
                <input
                  type="text"
                  value={prescription.duration}
                  onChange={(e) => setPrescription({ ...prescription, duration: e.target.value })}
                  placeholder="Duration (e.g., 3 days)"
                />
                <button onClick={sendPrescription} className="submit-button">
                  Send Prescription
                </button>
              </>
            )}
            <button onClick={() => setShowActionModal(false)} className="close-modal">
              Close
            </button>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .doctor-chat-container {
          width: 100vw;
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
          font-family: 'Poppins', sans-serif;
          color: #E0E0E0;
          overflow: hidden;
        }

        .chat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px 30px;
          background: rgba(44, 26, 61, 0.8);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .hamburger-button {
          background: none;
          border: none;
          color: #FFFFFF;
          font-size: 1.8rem;
          cursor: pointer;
          transition: transform 0.3s ease;
        }

        .hamburger-button:hover {
          transform: scale(1.1);
        }

        .chat-header h2 {
          font-size: 1.8rem;
          font-weight: 600;
          color: #FFFFFF;
          position: relative;
        }

        .chat-header h2::after {
          content: '';
          width: 40px;
          height: 4px;
          background: #6E48AA;
          position: absolute;
          bottom: -5px;
          left: 0;
          border-radius: 2px;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 15px;
        }

        .logout-button {
          padding: 8px 20px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 25px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .logout-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .chat-layout {
          display: flex;
          flex: 1;
          overflow: hidden;
        }

        .patient-sidebar {
          width: 0;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          padding: 0;
          border-right: 1px solid rgba(255, 255, 255, 0.1);
          overflow-y: auto;
          transition: width 0.3s ease, padding 0.3s ease;
        }

        .patient-sidebar.open {
          width: 250px;
          padding: 20px;
        }

        .sidebar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .sidebar-header h3 {
          font-size: 1.5rem;
          color: #FFFFFF;
        }

        .close-menu {
          background: none;
          border: none;
          color: #FFFFFF;
          font-size: 1.5rem;
          cursor: pointer;
          transition: transform 0.3s ease;
        }

        .close-menu:hover {
          transform: scale(1.1);
        }

        .loading-text,
        .no-patients {
          color: #A0A0A0;
          font-size: 1rem;
          text-align: center;
          margin-top: 20px;
        }

        .patient-list {
          list-style: none;
        }

        .patient-item {
          padding: 15px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          margin-bottom: 10px;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .patient-item:hover,
        .patient-item:focus {
          background: rgba(255, 255, 255, 0.2);
          transform: translateX(5px);
        }

        .patient-item.selected {
          background: #6E48AA;
          color: #FFFFFF;
        }

        .patient-item span {
          font-size: 1rem;
          font-weight: 500;
        }

        .patient-item small {
          display: block;
          font-size: 0.8rem;
          color: #B0B0B0;
          margin-top: 5px;
        }

        .chat-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 20px 30px;
          overflow-y: auto;
        }

        .doctor-profile {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 20px;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .doctor-profile h3 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #FFFFFF;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .doctor-profile h3::before {
          content: '👨‍⚕️';
          font-size: 1.4rem;
        }

        .doctor-profile p {
          font-size: 1rem;
          margin-bottom: 10px;
        }

        .close-section-button {
          padding: 8px 20px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
          margin-top: 10px;
        }

        .close-section-button:hover {
          background: #5A3E8B;
          transform: scale(1.05);
        }

        .diagnosis-prompt {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 30px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .diagnosis-prompt h3 {
          font-size: 1.5rem;
          color: #FFFFFF;
          margin-bottom: 20px;
        }

        .diagnosis-prompt p {
          font-size: 1.2rem;
          color: #E0E0E0;
          margin-bottom: 20px;
          text-align: center;
        }

        .prompt-buttons {
          display: flex;
          gap: 15px;
        }

        .accept-button {
          padding: 10px 25px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .accept-button:hover {
          background: #219653;
          transform: scale(1.05);
        }

        .decline-button {
          padding: 10px 25px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .decline-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .chat-main {
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .missed-dose-alerts {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 20px;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .missed-dose-alerts h3 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #E74C3C;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .missed-dose-alerts h3::before {
          content: '⚠️';
          font-size: 1.4rem;
        }

        .alert-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(231, 76, 60, 0.1);
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 10px;
        }

        .alert-item p {
          font-size: 1rem;
          color: #E0E0E0;
        }

        .dismiss-button {
          padding: 6px 12px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .dismiss-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .messages-container {
          flex: 1;
          padding: 20px;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          overflow-y: auto;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .no-messages,
        .loading-text {
          color: #A0A0A0;
          font-size: 1rem;
          text-align: center;
          margin-top: 20px;
        }

        .message {
          display: flex;
          margin-bottom: 20px;
          max-width: 70%;
          position: relative;
        }

        .patient-message {
          margin-left: auto;
          justify-content: flex-end;
        }

        .doctor-message {
          margin-right: auto;
          justify-content: flex-start;
        }

        .message-content {
          padding: 15px;
          border-radius: 15px;
          position: relative;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .patient-message .message-content {
          background: #6E48AA;
          color: #FFFFFF;
          border-bottom-right-radius: 5px;
        }

        .doctor-message .message-content {
          background: #4A3270;
          color: #E0E0E0;
          border-bottom-left-radius: 5px;
        }

        .message-content:hover {
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        }

        .message-content p {
          margin: 0 0 5px;
          font-size: 1rem;
          line-height: 1.4;
        }

        .translated-text {
          font-size: 0.85rem;
          font-style: italic;
          color: #B0B0B0;
          margin-top: 5px;
        }

        .audio-container {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .audio-container audio {
          width: 100%;
          border-radius: 10px;
        }

        .download-link {
          font-size: 0.85rem;
          color: #6E48AA;
          text-decoration: none;
          transition: color 0.3s ease;
        }

        .download-link:hover {
          color: #9D50BB;
          text-decoration: underline;
        }

        .read-aloud-buttons {
          display: flex;
          gap: 10px;
          margin-top: 5px;
        }

        .read-aloud-button {
          padding: 6px 12px;
          background: rgba(255, 255, 255, 0.1);
          color: #FFFFFF;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .read-aloud-button:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.05);
        }

        .recommendation-item {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          padding: 15px;
          margin-bottom: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 1rem;
          color: #E0E0E0;
          flex-wrap: wrap;
        }

        .recommendation-item strong {
          color: #FFFFFF;
        }

        .timestamp {
          font-size: 0.8rem;
          color: #A0A0A0;
          margin-top: 5px;
          display: block;
        }

        .error-message {
          color: #E74C3C;
          font-size: 0.9rem;
          text-align: center;
          margin-bottom: 20px;
          animation: shake 0.5s ease;
        }

        .controls {
          background: rgba(44, 26, 61, 0.8);
          backdrop-filter: blur(10px);
          padding: 20px;
          border-radius: 15px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .recording-buttons {
          display: flex;
          gap: 10px;
          align-items: center;
          margin-bottom: 15px;
        }

        .start-button {
          padding: 8px 20px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .start-button:hover {
          background: #219653;
          transform: scale(1.05);
        }

        .stop-button {
          padding: 8px 20px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .stop-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .action-button {
          padding: 8px 20px;
          background: #F39C12;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .action-button:hover {
          background: #E67E22;
          transform: scale(1.05);
        }

        .disabled-button {
          padding: 8px 20px;
          background: #666;
          color: #A0A0A0;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: not-allowed;
        }

        .text-input-container {
          display: flex;
          gap: 10px;
        }

        .text-input-container input {
          flex: 1;
          padding: 12px 20px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 25px;
          font-size: 1rem;
          color: #FFFFFF;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .text-input-container input:focus {
          outline: none;
          border-color: #6E48AA;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: rgba(255, 255, 255, 0.05);
        }

        .text-input-container input::placeholder {
          color: #A0A0A0;
        }

        .send-button {
          padding: 12px 30px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 25px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .send-button:hover {
          background: #5A3E8B;
          transform: scale(1.05);
        }

        .no-patient-selected {
          flex: 1;
          display: flex;
          justify-content: center;
          align-items: center;
          color: #A0A0A0;
          font-size: 1.2rem;
        }

        .action-modal {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 1000;
        }

        .modal-content {
          background: rgba(44, 26, 61, 0.95);
          backdrop-filter: blur(10px);
          padding: 30px;
          border-radius: 15px;
          width: 450px;
          max-width: 90%;
          display: flex;
          flex-direction: column;
          gap: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .modal-content h3 {
          font-size: 1.5rem;
          color: #FFFFFF;
          margin-bottom: 10px;
        }

        .modal-content select,
        .modal-content input,
        .modal-content textarea {
          width: 100%;
          padding: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 10px;
          color: #FFFFFF;
          font-size: 1rem;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .modal-content select:focus,
        .modal-content input:focus,
        .modal-content textarea:focus {
          outline: none;
          border-color: #6E48AA;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
        }

        .modal-content textarea {
          min-height: 100px;
          resize: none;
        }

        .submit-button {
          padding: 10px 20px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .submit-button:hover {
          background: #219653;
          transform: scale(1.05);
        }

        .close-modal {
          padding: 10px 20px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .close-modal:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        @keyframes shake {
          0%,
          100% {
            transform: translateX(0);
          }
          10%,
          30%,
          50%,
          70%,
          90% {
            transform: translateX(-5px);
          }
          20%,
          40%,
          60%,
          80% {
            transform: translateX(5px);
          }
        }
      `}</style>
    </div>
  );
}

export default DoctorChat;