import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithEmailAndPassword, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, query, collection, where, getDocs } from 'firebase/firestore';
import { auth, db } from '../services/firebase.js';

function PatientIdRecovery({ setError }) {
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState('');

  const handleRecover = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setIsLoading(true);

    if (!aadhaarNumber) {
      setError('Aadhaar number is required.');
      setIsLoading(false);
      return;
    }
    const aadhaarRegex = /^\d{12}$/;
    if (!aadhaarRegex.test(aadhaarNumber)) {
      setError('Invalid Aadhaar number (must be 12 digits).');
      setIsLoading(false);
      return;
    }
    if (!phoneNumber) {
      setError('Phone number is required.');
      setIsLoading(false);
      return;
    }
    const phoneRegex = /^\+91\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      setError('Invalid phone number (use +91 followed by 10 digits).');
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch(`${process.env.REACT_APP_API_URL}/auth/recover-patient-id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ aadhaarNumber, phoneNumber }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error.message || 'Recovery failed');
      }

      setSuccess('Your Patient ID has been sent to your phone number via SMS.');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="recovery-container">
      <h3>Recover Patient ID</h3>
      <form onSubmit={handleRecover}>
        <div className="form-group">
          <label htmlFor="aadhaarNumber">Aadhaar Number</label>
          <input
            type="text"
            id="aadhaarNumber"
            value={aadhaarNumber}
            onChange={(e) => setAadhaarNumber(e.target.value)}
            placeholder="Enter your 12-digit Aadhaar number"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="phoneNumber">Phone Number</label>
          <input
            type="text"
            id="phoneNumber"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="e.g., +919876543210"
            required
          />
        </div>
        {success && <p className="success-message">{success}</p>}
        <button type="submit" disabled={isLoading} className="recover-button">
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
            'Recover ID'
          )}
        </button>
      </form>
    </div>
  );
}

function Login({ setUser, setRole, setPatientId, user, setError: setParentError }) {
  const [loginType, setLoginType] = useState('patient'); // 'patient' or 'doctorAdmin'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [patientId, setPatientIdInput] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const { username: initialUsername, password: initialPassword } = location.state || {};

  useEffect(() => {
    if (initialUsername) setEmail(initialUsername);
    if (initialPassword) setPassword(initialPassword);
  }, [initialUsername, initialPassword]);

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

  const handleInputChange = (setter) => (e) => {
    if (error) {
      setError('');
      setParentError('');
    }
    setter(e.target.value);
  };

  const handlePatientLogin = async (e) => {
    e.preventDefault();
    if (isLoading) return;
    setError('');
    setParentError('');
    setIsLoading(true);

    if (!patientId.trim()) {
      setError('Patient ID is required.');
      setIsLoading(false);
      return;
    }
    if (!password) {
      setError('Password is required.');
      setIsLoading(false);
      return;
    }

    try {
      // Fetch the patient's email from Firestore using the patientId
      const patientQuery = query(collection(db, 'patients'), where('patientId', '==', patientId));
      const querySnapshot = await getDocs(patientQuery);

      if (querySnapshot.empty) {
        throw new Error('Patient ID not found');
      }

      const patientData = querySnapshot.docs[0].data();
      const patientEmail = patientData.email;

      if (!patientEmail) {
        throw new Error('Email not found for this patient');
      }

      // Sign in with Firebase Auth using the email and password
      const userCredential = await signInWithEmailAndPassword(auth, patientEmail, password);
      const firebaseUser = userCredential.user;

      // Fetch patient data to populate user state
      const updatedUser = {
        uid: firebaseUser.uid,
        role: 'patient',
        patientId: patientId,
        name: patientData.name,
        email: patientEmail,
        sex: patientData.sex,
        age: patientData.age,
      };

      setUser(updatedUser);
      setRole('patient');
      setPatientId(patientId);
      localStorage.setItem('userId', firebaseUser.uid);
      localStorage.setItem('patientId', patientId);

      navigate('/patient/select-doctor');
    } catch (error) {
      let errorMessage = 'Login failed. Please try again.';
      if (error.message.includes('Patient ID not found')) {
        errorMessage = 'Patient ID not found. Please check your ID or register.';
      } else if (error.code === 'auth/wrong-password') {
        errorMessage = 'Incorrect password. Please try again.';
      } else if (error.code === 'auth/invalid-credential') {
        errorMessage = 'Invalid credentials. Please check your Patient ID and password.';
      } else if (error.message.includes('Email not found')) {
        errorMessage = 'Email not found for this patient. Please contact support.';
      }
      setError(errorMessage);
      setParentError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDoctorAdminLogin = async (e) => {
    e.preventDefault();
    if (isLoading) return;
    setError('');
    setParentError('');
    setIsLoading(true);

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

    console.log('Attempting login with:', { email, password });

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
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
        email,
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
        errorMessage = 'Invalid email or password. Please try again.';
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

  const handleLogin = (e) => {
    if (loginType === 'patient') {
      handlePatientLogin(e);
    } else {
      handleDoctorAdminLogin(e);
    }
  };

  const goToRegister = () => {
    console.log('First Time Login clicked, redirecting to /register');
    navigate('/register');
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h2>Login</h2>
        <div className="login-type-toggle">
          <button
            className={loginType === 'patient' ? 'active' : ''}
            onClick={() => setLoginType('patient')}
          >
            Patient Login
          </button>
          <button
            className={loginType === 'doctorAdmin' ? 'active' : ''}
            onClick={() => setLoginType('doctorAdmin')}
          >
            Doctor/Admin Login
          </button>
        </div>
        <form onSubmit={handleLogin}>
          {loginType === 'patient' ? (
            <>
              <div className="form-group">
                <label htmlFor="patientId">Patient ID</label>
                <input
                  type="text"
                  id="patientId"
                  value={patientId}
                  onChange={handleInputChange(setPatientIdInput)}
                  required
                  placeholder="Enter your Patient ID (e.g., 3eev94)"
                />
              </div>
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
            </>
          ) : (
            <>
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
            </>
          )}
          {error && <p className="error-message">{error}</p>}
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
        {loginType === 'patient' && (
          <p className="recovery-prompt">
            Forgot your Patient ID?{' '}
            <span className="recovery-link" onClick={() => setShowRecovery(true)}>
              Recover here
            </span>
          </p>
        )}
        <p className="register-prompt">
          First Time Login?{' '}
          <span className="register-link" onClick={goToRegister}>
            Register here
          </span>
        </p>
        {showRecovery && <PatientIdRecovery setError={setError} />}
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

        .login-type-toggle {
          display: flex;
          justify-content: center;
          margin-bottom: 20px;
        }

        .login-type-toggle button {
          padding: 8px 16px;
          border: none;
          background: rgba(255, 255, 255, 0.1);
          color: #E0E0E0;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, color 0.3s ease;
          border-radius: 20px;
          margin: 0 5px;
        }

        .login-type-toggle button.active {
          background: #6E48AA;
          color: #FFFFFF;
        }

        .login-type-toggle button:hover:not(.active) {
          background: rgba(255, 255, 255, 0.2);
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

        input {
          width: 100%;
          padding: 12px 15px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          font-size: 1rem;
          color: #FFFFFF;
          background: rgba(255, 255, 255, 0.1);
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        input:focus {
          outline: none;
          border-color: #6E48AA;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: rgba(255, 255, 255, 0.15);
        }

        input::placeholder {
          color: #A0A0A0;
        }

        .error-message {
          color: #E74C3C;
          font-size: 0.9rem;
          margin-bottom: 20px;
          animation: shake 0.5s ease;
        }

        .success-message {
          color: #2ECC71;
          font-size: 0.9rem;
          margin-bottom: 20px;
        }

        .login-button, .recover-button {
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

        .login-button:disabled, .recover-button:disabled {
          background: #666;
          color: #A0A0A0;
          cursor: not-allowed;
        }

        .login-button:hover:not(:disabled), .recover-button:hover:not(:disabled) {
          transform: scale(1.05);
          background: #5A3E8B;
        }

        .login-button::before, .recover-button::before {
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

        .login-button:hover::before, .recover-button:hover::before {
          left: 100%;
        }

        .recovery-prompt, .register-prompt {
          margin-top: 20px;
          font-size: 0.95rem;
          color: #E0E0E0;
        }

        .recovery-link, .register-link {
          color: #6E48AA;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.3s ease, transform 0.3s ease;
          display: inline-block;
        }

        .recovery-link:hover, .register-link:hover {
          color: #5A3E8B;
          transform: translateX(5px);
        }

        .recovery-container {
          margin-top: 20px;
          background: rgba(255, 255, 255, 0.05);
          padding: 20px;
          border-radius: 10px;
        }

        .recovery-container h3 {
          font-size: 1.2rem;
          color: #FFFFFF;
          margin-bottom: 15px;
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