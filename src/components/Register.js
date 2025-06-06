// src/components/Register.js
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc, getDocs, query, collection, where } from 'firebase/firestore';
import { auth, db } from '../services/firebase.js';

function Register({ setUser, setRole, user }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [sex, setSex] = useState('');
  const [age, setAge] = useState('');
  const [address, setAddress] = useState('');
  const [patientId, setPatientId] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const { username: initialEmail, password: initialPassword } = location.state || {};

  // Generate a unique 6-character alphanumeric patientId
  const generatePatientId = async () => {
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let generatedId = '';
    const patientIdsRef = collection(db, 'patients');

    while (true) {
      generatedId = '';
      for (let i = 0; i < 6; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        generatedId += characters[randomIndex];
      }

      const q = query(patientIdsRef, where('patientId', '==', generatedId));
      const querySnapshot = await getDocs(q);
      if (querySnapshot.empty) break;
      console.log(`Register.js: Generated patientId ${generatedId} already exists, regenerating...`);
    }

    return generatedId;
  };

  useEffect(() => {
    if (initialEmail) setEmail(initialEmail);
    if (initialPassword) setPassword(initialPassword);

    generatePatientId()
      .then((uniqueId) => {
        setPatientId(uniqueId);
        console.log('Register.js: Generated unique patientId:', uniqueId);
      })
      .catch((err) => {
        console.error('Register.js: Error generating patientId:', err);
        setError('Failed to generate patient ID. Please try again.');
      });
  }, [initialEmail, initialPassword]);

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    if (!termsAccepted) {
      setError('You must accept the terms and conditions.');
      setIsLoading(false);
      return;
    }

    if (!email.trim()) {
      setError('Email is required.');
      setIsLoading(false);
      return;
    }
    if (!email.endsWith('@gmail.com')) {
      setError('Email must be a valid Gmail address (e.g., example@gmail.com).');
      setIsLoading(false);
      return;
    }
    if (!password) {
      setError('Password is required.');
      setIsLoading(false);
      return;
    }
    if (!name.trim()) {
      setError('Name is required.');
      setIsLoading(false);
      return;
    }
    if (!sex) {
      setError('Sex is required.');
      setIsLoading(false);
      return;
    }
    if (!age || isNaN(age) || age <= 0) {
      setError('Please enter a valid age.');
      setIsLoading(false);
      return;
    }
    if (!address.trim()) {
      setError('Address is required.');
      setIsLoading(false);
      return;
    }
    if (!patientId) {
      setError('Patient ID generation failed. Please try again.');
      setIsLoading(false);
      return;
    }

    console.log('Register.js: Attempting registration with:', { email, password, role: 'patient' });

    try {
      // Step 1: Register user with Firebase Authentication
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;
      console.log('Register.js: User registered in Firebase Auth:', firebaseUser.uid);

      // Step 2: Store user data in Firestore (users collection)
      const userDocRef = doc(db, 'users', firebaseUser.uid);
      const userData = {
        uid: firebaseUser.uid,
        email,
        role: 'patient',
        createdAt: new Date().toISOString(),
        name,
        sex,
        age: parseInt(age),
        address,
        patientId,
      };
      await setDoc(userDocRef, userData);
      console.log('Register.js: User data stored in Firestore (users):', firebaseUser.uid);

      // Step 3: Store patient data in Firestore (patients collection)
      const patientDocRef = doc(db, 'patients', patientId);
      const patientData = {
        uid: firebaseUser.uid,
        patientId,
        name,
        sex,
        age: parseInt(age),
        address,
        createdAt: new Date().toISOString(),
      };
      await setDoc(patientDocRef, patientData);
      console.log('Register.js: Patient data stored in Firestore (patients):', patientId);

      // Step 4: Store patient profile in backend (assumed GCS or similar)
      try {
        const patientProfile = {
          patientId,
          name,
          sex,
          age: parseInt(age),
          address,
          uid: firebaseUser.uid,
          createdAt: new Date().toISOString(),
        };

        const response = await fetch('http://localhost:5005/store-patient-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patientProfile),
          credentials: 'include', // Include credentials for session management
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to store patient profile: ${response.statusText} - ${errorText}`);
        }

        console.log('Register.js: Patient profile stored in backend:', patientId);
      } catch (backendError) {
        console.error('Register.js: Backend storage error:', backendError.message);
        setError(`Registration successful, but failed to store patient profile in backend: ${backendError.message}`);
      }

      // Step 5: Update application state and redirect
      const updatedUser = { uid: firebaseUser.uid, email, role: 'patient', patientId, name, sex, age, address };
      setUser(updatedUser);
      setRole('patient');
      localStorage.setItem('userId', firebaseUser.uid);
      localStorage.setItem('patientId', patientId);

      navigate('/');
    } catch (error) {
      console.error('Register.js: Registration error:', error.message);
      if (error.code === 'auth/email-already-in-use') {
        setError('This email is already registered. Please login instead.');
      } else if (error.code === 'auth/invalid-email') {
        setError('Please enter a valid Gmail address (e.g., example@gmail.com).');
      } else if (error.code === 'auth/weak-password') {
        setError('Password should be at least 6 characters long.');
      } else {
        setError(`Registration failed: ${error.message}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    setRole(null);
    localStorage.removeItem('userId');
    localStorage.removeItem('patientId');
    navigate('/login');
  };

  const goToLogin = () => {
    navigate('/login', { state: { username: email, password } });
  };

  return (
    <div className="register-page">
      <div className="form-sections">
        {/* Left Section: General Information */}
        <div className="form-section left-section">
          <h3>Patient Registration</h3>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Enter your Gmail address (e.g., example@gmail.com)"
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Enter your password"
            />
          </div>
          <div className="form-group">
            <label htmlFor="name">Name</label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Enter your name"
            />
          </div>
        </div>

        {/* Right Section: Additional Details */}
        <div className="form-section right-section">
          <h3>Additional Details</h3>
          <div className="form-group">
            <label htmlFor="sex">Sex</label>
            <select
              id="sex"
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              required
            >
              <option value="" disabled>Select sex</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="age">Age</label>
            <input
              type="number"
              id="age"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              required
              placeholder="Enter your age"
              min="1"
            />
          </div>
          <div className="form-group">
            <label htmlFor="address">Address</label>
            <input
              type="text"
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
              placeholder="Enter your address"
            />
          </div>
          <div className="form-group">
            <label htmlFor="patientId">Patient ID</label>
            <input
              type="text"
              id="patientId"
              value={patientId}
              readOnly
              placeholder="Auto-generated Patient ID"
            />
          </div>
          {error && <p className="error-message">{error}</p>}
          <div className="terms-group">
            <input
              type="checkbox"
              id="terms"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <label htmlFor="terms" className="terms-label">
              I accept the terms and conditions of this site.
            </label>
          </div>
          <button
            onClick={handleRegister}
            disabled={isLoading}
            className="register-button"
          >
            {isLoading ? (
              <svg
                className="spinner"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
            ) : (
              'Register Now'
            )}
          </button>
          <p className="login-prompt">
            Already have an account?{' '}
            <span className="login-link" onClick={goToLogin}>
              Login here
            </span>
          </p>
          {user && (
            <button onClick={handleLogout} className="logout-button">
              Logout
            </button>
          )}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap');

        .register-page {
          min-height: 100vh;
          width: 100vw;
          display: flex;
          justify-content: center;
          align-items: flex-start;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          font-family: 'Poppins', sans-serif;
          overflow-y: auto;
          margin: 0;
          padding: 0;
        }

        .form-sections {
          display: flex;
          width: 100%;
          height: 100%;
          flex: 1;
        }

        .form-section {
          padding: 40px;
          flex: 1;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
        }

        .left-section {
          background: #ffffff;
        }

        .right-section {
          background: #6e48aa;
          color: #ffffff;
        }

        h3 {
          font-size: 1.5rem;
          font-weight: 600;
          margin-bottom: 30px;
          color: #6e48aa;
        }

        .right-section h3 {
          color: #ffffff;
        }

        .form-group {
          margin-bottom: 25px;
          width: 100%;
        }

        label {
          font-size: 1rem;
          font-weight: 500;
          display: block;
          margin-bottom: 8px;
          color: #6e48aa;
        }

        .right-section label {
          color: #ffffff;
        }

        input,
        select {
          width: 100%;
          padding: 10px 15px;
          border: 2px solid #e0e0e0;
          border-radius: 5px;
          font-size: 1rem;
          color: #333;
          background: #ffffff;
          transition: border-color 0.3s ease;
        }

        .right-section input,
        .right-section select {
          border: 2px solid rgba(255, 255, 255, 0.3);
          background: #ffffff;
          color: #333;
        }

        input:focus,
        select:focus {
          outline: none;
          border-color: #6e48aa;
        }

        .right-section input:focus,
        .right-section select:focus {
          border-color: #ffffff;
        }

        input::placeholder,
        select:invalid {
          color: #bbb;
        }

        select option {
          color: #333;
          background: #ffffff;
        }

        select {
          color: #333;
        }

        select:invalid {
          color: #bbb;
        }

        input[readonly] {
          background: #e9ecef;
          cursor: not-allowed;
          color: #333;
        }

        .error-message {
          color: #ff4d4d;
          font-size: 0.9rem;
          margin-bottom: 20px;
          text-align: center;
          background: rgba(255, 77, 77, 0.1);
          padding: 8px;
          border-radius: 8px;
          animation: shake 0.5s ease;
        }

        .terms-group {
          display: flex;
          align-items: center;
          margin-bottom: 20px;
        }

        .terms-group input {
          width: auto;
          margin-right: 10px;
        }

        .terms-label {
          font-size: 0.9rem;
          color: #ffffff;
          margin-bottom: 0;
        }

        .register-button {
          width: 150px;
          height: 50px; /* Adjusted from circular to rectangular */
          background: #ffffff;
          color: #6e48aa;
          border: none;
          border-radius: 8px;
          font-size: 1.1rem;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 20px auto;
        }

        .register-button:disabled {
          background: #e0e0e0;
          color: #999;
          cursor: not-allowed;
        }

        .register-button:hover:not(:disabled) {
          transform: scale(1.05);
          box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);
        }

        .logout-button {
          display: block;
          margin: 20px auto;
          padding: 8px 16px;
          background: #ff4d4d;
          color: #fff;
          border: none;
          border-radius: 20px;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .logout-button:hover {
          background: #e43c3c;
          transform: translateY(-2px);
        }

        .login-prompt {
          font-size: 0.95rem;
          color: #ffffff;
          text-align: center;
          margin-top: 20px;
        }

        .login-link {
          color: #ffffff;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.3s ease;
          text-decoration: underline;
        }

        .login-link:hover {
          color: #e0e0e0;
        }

        .spinner {
          animation: spin 1s linear infinite;
          width: 24px;
          height: 24px;
          margin: 0 auto;
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes shake {
          0%, 100% {
            transform: translateX(0);
          }
          10%, 30%, 50%, 70%, 90% {
            transform: translateX(-5px);
          }
          20%, 40%, 60%, 80% {
            transform: translateX(5px);
          }
        }

        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @media (max-width: 768px) {
          .form-sections {
            flex-direction: column;
          }

          .form-section {
            min-height: auto;
          }

          .register-page {
            width: 100%;
          }
        }

        @media (max-width: 480px) {
          .form-section {
            padding: 20px;
          }

          h3 {
            font-size: 1.2rem;
          }

          .register-button {
            width: 120px;
            height: 40px;
            font-size: 0.9rem;
          }
        }
      `}</style>
    </div>
  );
}

export default Register;