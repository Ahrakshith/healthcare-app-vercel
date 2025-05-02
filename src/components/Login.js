import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithEmailAndPassword, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, query, collection, where, getDocs } from 'firebase/firestore';
import { auth, db } from '../services/firebase.js';

function Login({ setUser, setRole, setPatientId, user, setError: setParentError }) {
  const [userType, setUserType] = useState(''); // New state for user type
  const [email, setEmail] = useState('');
  const [patientId, setPatientId] = useState(''); // New state for patientId
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false); // State to toggle recovery form
  const [aadhaarNumber, setAadhaarNumber] = useState(''); // State for recovery form
  const [phoneNumber, setPhoneNumber] = useState(''); // State for recovery form
  const [recoveredId, setRecoveredId] = useState(''); // State to store recovered patientId
  const navigate = useNavigate();
  const location = useLocation();

  const { username: initialUsername, password: initialPassword } = location.state || {};

  // Set initial email and password from location state (e.g., from registration)
  useEffect(() => {
    if (initialUsername) setEmail(initialUsername);
    if (initialPassword) setPassword(initialPassword);
  }, [initialUsername, initialPassword]);

  // Check for existing user session on component mount
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        console.log('User already authenticated:', { uid: firebaseUser.uid, email: firebaseUser.email });

        try {
          const idToken = await firebaseUser.getIdToken(true);
          const apiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
          const response = await fetch(`${apiUrl}/users/${firebaseUser.uid}`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${idToken}`,
              'x-user-uid': firebaseUser.uid,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            credentials: 'include',
          });

          const responseText = await response.text();
          console.log('API response for auth state:', {
            status: response.status,
            ok: response.ok,
            rawResponse: responseText.substring(0, 100) + (responseText.length > 100 ? '...' : ''),
          });

          let userData;
          if (response.ok) {
            try {
              userData = JSON.parse(responseText);
              if (!userData || typeof userData !== 'object' || !userData.role) {
                throw new Error('Invalid user data structure or missing role');
              }
            } catch (parseError) {
              console.error('JSON parsing failed during auth state change:', parseError.message, 'Raw response:', responseText);
              throw new Error('Invalid JSON response from server');
            }
          } else {
            console.warn('API request failed, falling back to Firestore', { status: response.status });
            // Fallback to Firestore
            const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
            if (!userDoc.exists()) {
              throw new Error('User not found in Firestore');
            }
            userData = userDoc.data();
            if (!userData.role) {
              throw new Error('Missing role in Firestore user data');
            }
          }

          const updatedUser = {
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            role: userData.role,
            patientId: userData.patientId || null,
            name: userData.name || null,
            sex: userData.sex || null,
            age: userData.age || null,
          };

          setUser(updatedUser);
          setRole(userData.role);
          if (userData.role === 'patient' && userData.patientId) {
            setPatientId(userData.patientId);
            localStorage.setItem('patientId', userData.patientId);
          }
          localStorage.setItem('userId', firebaseUser.uid);
        } catch (error) {
          console.error('Error during auth state change:', error.message);
          setError(`Authentication error: ${error.message}`);
          setParentError(`Authentication error: ${error.message}`);
          setUser(null);
          setRole(null);
          setPatientId(null);
          localStorage.removeItem('userId');
          localStorage.removeItem('patientId');
          navigate('/login');
        }
      } else {
        setUser(null);
        setRole(null);
        setPatientId(null);
        localStorage.removeItem('userId');
        localStorage.removeItem('patientId');
      }
    });

    return () => unsubscribe();
  }, [navigate, setUser, setRole, setPatientId]);

  // Clear error when user starts typing
  const handleInputChange = (setter) => (e) => {
    if (error) {
      setError('');
      setParentError('');
    }
    setter(e.target.value);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (isLoading) return;
    setError('');
    setParentError('');
    setIsLoading(true);

    // Validate user type selection
    if (!userType) {
      setError('Please select a user type.');
      setIsLoading(false);
      console.error('Login validation error: User type not selected');
      return;
    }

    let loginEmail = email;

    // For patient login, map patientId to email
    if (userType === 'patient') {
      if (!patientId.trim()) {
        setError('Patient ID is required.');
        setIsLoading(false);
        console.error('Login validation error: Patient ID is empty');
        return;
      }

      try {
        const q = query(collection(db, 'patients'), where('patientId', '==', patientId));
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
          setError('Patient ID not found. Please check your ID or register.');
          setIsLoading(false);
          console.error('Login validation error: Patient ID not found in Firestore');
          return;
        }

        const patientData = querySnapshot.docs[0].data();
        loginEmail = patientData.email;
        if (!loginEmail) {
          setError('No email associated with this Patient ID. Please contact support.');
          setIsLoading(false);
          console.error('Login validation error: No email found for patientId:', patientId);
          return;
        }
      } catch (err) {
        setError('Error fetching patient data. Please try again.');
        setIsLoading(false);
        console.error('Error querying patient by patientId:', err.message);
        return;
      }
    } else {
      // Admin or Doctor login validation
      if (!email.trim()) {
        setError('Email is required.');
        setIsLoading(false);
        console.error('Login validation error: Email is empty');
        return;
      }

      if (!email.endsWith('@gmail.com')) {
        setError('Please enter a valid Gmail address (e.g., example@gmail.com).');
        setIsLoading(false);
        console.error('Login validation error: Invalid email domain, must end with @gmail.com');
        return;
      }
    }

    if (!password) {
      setError('Password is required.');
      setIsLoading(false);
      console.error('Login validation error: Password is empty');
      return;
    }

    console.log('Attempting login with:', { userType, email: loginEmail, password });

    try {
      const userCredential = await signInWithEmailAndPassword(auth, loginEmail, password);
      const firebaseUser = userCredential.user;
      console.log('User logged in successfully:', { uid: firebaseUser.uid, email: firebaseUser.email });

      const idToken = await firebaseUser.getIdToken(true);
      console.log('Firebase ID token:', idToken.substring(0, 10) + '...');

      const apiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
      console.log('Fetching user data from:', `${apiUrl}/users/${firebaseUser.uid}`);

      let response;
      let attempt = 0;
      const maxAttempts = 3;
      let userData;
      while (attempt < maxAttempts) {
        response = await fetch(`${apiUrl}/users/${firebaseUser.uid}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'x-user-uid': firebaseUser.uid,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          credentials: 'include',
        });

        const responseText = await response.text();
        console.log(`API response (attempt ${attempt + 1}/${maxAttempts}):`, {
          status: response.status,
          ok: response.ok,
          rawResponse: responseText.substring(0, 100) + (responseText.length > 100 ? '...' : ''),
        });

        if (!response.ok) {
          // Fallback to Firestore if API fails
          console.warn('API request failed, falling back to Firestore', { status: response.status });
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (!userDoc.exists()) {
            throw new Error('User not found in Firestore');
          }
          userData = userDoc.data();
          if (!userData.role) {
            throw new Error('Missing role in Firestore user data');
          }
          break;
        }

        try {
          userData = JSON.parse(responseText);
          if (!userData || typeof userData !== 'object' || !userData.role) {
            throw new Error('Invalid user data structure or missing role');
          }
          break;
        } catch (parseError) {
          console.error('JSON parsing failed:', parseError.message, 'Raw response:', responseText);
          if (attempt === maxAttempts - 1) {
            // Fallback to Firestore after retries
            console.warn('Falling back to Firestore after failed retries');
            const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
            if (!userDoc.exists()) {
              throw new Error('User not found in Firestore');
            }
            userData = userDoc.data();
            if (!userData.role) {
              throw new Error('Missing role in Firestore user data');
            }
            break;
          }
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }

      const updatedUser = {
        uid: firebaseUser.uid,
        email: loginEmail,
        role: userData.role,
        patientId: userData.patientId || null,
        name: userData.name || null,
        sex: userData.sex || null,
        age: userData.age || null,
      };

      console.log('Setting user state:', updatedUser);
      setUser(updatedUser);
      setRole(userData.role);
      if (userData.role === 'patient' && userData.patientId) {
        setPatientId(userData.patientId);
        localStorage.setItem('patientId', userData.patientId);
        console.log('Set patientId in localStorage:', userData.patientId);
      }
      localStorage.setItem('userId', firebaseUser.uid);
      console.log('Set userId in localStorage:', firebaseUser.uid);
    } catch (error) {
      console.error('Login process error:', { message: error.message, code: error.code, stack: error.stack });
      let errorMessage = 'Login failed. Please try again.';
      if (error.code === 'auth/invalid-credential') {
        errorMessage = 'Invalid Patient ID or password. Please try again.';
      } else if (error.code === 'auth/user-not-found') {
        errorMessage = 'User not found. Please register first.';
      } else if (error.code === 'auth/wrong-password') {
        errorMessage = 'Incorrect password. Please try again.';
      } else if (error.message.includes('User not found in Firestore')) {
        errorMessage = 'User data not found. Please register or contact support.';
      } else if (error.message.includes('Missing role')) {
        errorMessage = 'User role not configured. Please contact support.';
      } else if (error.message.includes('HTTP error') || error.message.includes('invalid JSON')) {
        errorMessage = 'Server error: Unable to fetch user data. Please try again later or contact support.';
      } else {
        errorMessage = `Login failed: ${error.message}`;
      }
      setError(errorMessage);
      setParentError(errorMessage);
    } finally {
      console.log('Login process completed, isLoading set to false');
      setIsLoading(false);
    }
  };

  const handleRecoverId = async (e) => {
    e.preventDefault();
    setError('');
    setRecoveredId('');
    setIsLoading(true);

    // Validate Aadhaar and phone number
    const aadhaarRegex = /^\d{12}$/;
    if (!aadhaarRegex.test(aadhaarNumber)) {
      setError('Invalid Aadhaar number (must be 12 digits).');
      setIsLoading(false);
      return;
    }
    const phoneRegex = /^\+91\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      setError('Invalid phone number (use +91 followed by 10 digits, e.g., +919876543210).');
      setIsLoading(false);
      return;
    }

    try {
      const q = query(
        collection(db, 'patients'),
        where('aadhaarNumber', '==', aadhaarNumber),
        where('phoneNumber', '==', phoneNumber)
      );
      const querySnapshot = await getDocs(q);
      if (querySnapshot.empty) {
        setError('No patient found with this Aadhaar number and phone number.');
        setIsLoading(false);
        return;
      }

      const patientData = querySnapshot.docs[0].data();
      setRecoveredId(patientData.patientId);
    } catch (err) {
      setError('Error recovering Patient ID. Please try again.');
      console.error('Error recovering patientId:', err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const goToRegister = () => {
    console.log('First Time Login clicked, redirecting to /register');
    navigate('/register', { state: { username: email, password } });
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h2>{showRecovery ? 'Recover Patient ID' : 'Login'}</h2>
        {!showRecovery ? (
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="userType">User Type</label>
              <select
                id="userType"
                value={userType}
                onChange={(e) => {
                  setUserType(e.target.value);
                  setError('');
                  setPatientId('');
                  setEmail('');
                }}
                required
              >
                <option value="" disabled>Select user type</option>
                <option value="admin">Admin</option>
                <option value="doctor">Doctor</option>
                <option value="patient">Patient</option>
              </select>
            </div>
            {userType === 'patient' ? (
              <div className="form-group">
                <label htmlFor="patientId">Patient ID</label>
                <input
                  type="text"
                  id="patientId"
                  value={patientId}
                  onChange={handleInputChange(setPatientId)}
                  required
                  placeholder="Enter your Patient ID"
                />
              </div>
            ) : (
              <div className="form-group">
                <label htmlFor="email">Email</label>
                <input
                  type="email"
                  id="email"
                  value={email}
                  onChange={handleInputChange(setEmail)}
                  required
                  placeholder="Enter your Gmail address (e.g., example@gmail.com)"
                />
              </div>
            )}
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={handleInputChange(setPassword)}
                required
                placeholder="Enter your password"
              />
            </div>
            {error && <p className="error-message">{error}</p>}
            {userType === 'patient' && (
              <p className="recover-link">
                Forgot your Patient ID?{' '}
                <span
                  className="register-link"
                  onClick={() => {
                    setShowRecovery(true);
                    setError('');
                    setRecoveredId('');
                  }}
                >
                  Recover here
                </span>
              </p>
            )}
            <button type="submit" disabled={isLoading} className="login-button">
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
                'Login'
              )}
            </button>
          </form>
        ) : (
          <form onSubmit={handleRecoverId}>
            <div className="form-group">
              <label htmlFor="aadhaarNumber">Aadhaar Number</label>
              <input
                type="text"
                id="aadhaarNumber"
                value={aadhaarNumber}
                onChange={handleInputChange(setAadhaarNumber)}
                required
                placeholder="Enter your 12-digit Aadhaar number"
              />
            </div>
            <div className="form-group">
              <label htmlFor="phoneNumber">Phone Number</label>
              <input
                type="text"
                id="phoneNumber"
                value={phoneNumber}
                onChange={handleInputChange(setPhoneNumber)}
                required
                placeholder="Enter your phone number (e.g., +919876543210)"
              />
            </div>
            {error && <p className="error-message">{error}</p>}
            {recoveredId && (
              <p className="success-message">
                Your Patient ID is: <strong>{recoveredId}</strong>
              </p>
            )}
            <button type="submit" disabled={isLoading} className="login-button">
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
                'Recover Patient ID'
              )}
            </button>
            <p className="back-link">
              <span
                className="register-link"
                onClick={() => {
                  setShowRecovery(false);
                  setError('');
                  setRecoveredId('');
                  setAadhaarNumber('');
                  setPhoneNumber('');
                }}
              >
                Back to Login
              </span>
            </p>
          </form>
        )}
        {!showRecovery && (
          <p className="register-prompt">
            First Time Login?{' '}
            <span className="register-link" onClick={goToRegister}>
              Register here
            </span>
          </p>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

        .login-container {
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
          padding: 20px;
          font-family: 'Poppins', sans-serif;
        }

        .login-card {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
          width: 100%;
          max-width: 400px;
          text-align: center;
          animation: fadeIn 0.5s ease-in-out;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .login-card:hover {
          transform: translateY(-5px);
          box-shadow: 0 15px 40px rgba(0, 0, 0, 0.3);
        }

        h2 {
          font-size: 2.5rem;
          color: #FFFFFF;
          margin-bottom: 30px;
          position: relative;
        }

        h2::after {
          content: '';
          width: 50px;
          height: 4px;
          background: #6E48AA;
          position: absolute;
          bottom: -10px;
          left: 50%;
          transform: translateX(-50%);
          border-radius: 2px;
        }

        .form-group {
          margin-bottom: 25px;
          text-align: left;
        }

        label {
          display: block;
          font-size: 1rem;
          color: #E0E0E0;
          margin-bottom: 8px;
          font-weight: 500;
        }

        input,
        select {
          width: 100%;
          padding: 12px 15px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          font-size: 1rem;
          color: #FFFFFF;
          background: rgba(255, 255, 255, 0.1);
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        input:focus,
        select:focus {
          outline: none;
          border-color: #6E48AA;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: rgba(255, 255, 255, 0.15);
        }

        input::placeholder,
        select:invalid {
          color: #A0A0A0;
        }

        select {
          color: #FFFFFF;
        }

        select:invalid {
          color: #A0A0A0;
        }

        select option {
          color: #333;
          background: #FFFFFF;
        }

        .error-message {
          color: #E74C3C;
          font-size: 0.9rem;
          margin-bottom: 20px;
          animation: shake 0.5s ease;
        }

        .success-message {
          color: #2ECC71;
          font-size: 0.95rem;
          margin-bottom: 20px;
          background: rgba(46, 204, 113, 0.1);
          padding: 10px;
          border-radius: 5px;
        }

        .login-button {
          width: 100%;
          padding: 12px;
          border: none;
          border-radius: 8px;
          font-size: 1.1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
          position: relative;
          overflow: hidden;
          background: #6E48AA;
          color: #FFFFFF;
        }

        .login-button:disabled {
          background: #666;
          color: #A0A0A0;
          cursor: not-allowed;
        }

        .login-button:hover:not(:disabled) {
          transform: scale(1.05);
          background: #5A3E8B;
        }

        .login-button::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.2),
            transparent
          );
          transition: 0.5s;
        }

        .login-button:hover::before {
          left: 100%;
        }

        .register-prompt,
        .recover-link,
        .back-link {
          margin-top: 20px;
          font-size: 0.95rem;
          color: #E0E0E0;
        }

        .register-link {
          color: #6E48AA;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.3s ease, transform 0.3s ease;
          display: inline-block;
        }

        .register-link:hover {
          color: #5A3E8B;
          transform: translateX(5px);
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
      `}</style>
    </div>
  );
}

export default Login;