import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithEmailAndPassword, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../services/firebase.js';

function Login({ setUser, setRole, setPatientId, user, setError: setParentError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const { username: initialUsername, password: initialPassword } = location.state || {};

  // Set initial email and password from location state (e.g., from registration)
  useEffect(() => {
    if (initialUsername) setEmail(initialUsername);
    if (initialPassword) setPassword(initialPassword);
  }, [initialUsername, initialPassword]);

  // Memoize redirectUser to avoid recreating the function on every render
  const redirectUser = useCallback(
    (role) => {
      if (role === 'patient') {
        navigate('/patient/select-doctor');
      } else if (role === 'doctor') {
        navigate('/doctor/chat');
      } else if (role === 'admin') {
        navigate('/admin');
      } else {
        navigate('/login');
      }
      console.log(`Redirected to ${role} route`);
    },
    [navigate]
  );

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

          if (!response.ok) {
            const errorText = await response.text();
            console.error('Failed to fetch user data on auth state change:', response.status, errorText);
            setError('Failed to fetch user data. Please log in again.');
            setUser(null);
            setRole(null);
            setPatientId(null);
            localStorage.removeItem('userId');
            localStorage.removeItem('patientId');
            navigate('/login');
            return;
          }

          const userData = await response.json();
          if (!userData || !userData.role) {
            throw new Error('Invalid user data received from server, missing role');
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

          redirectUser(userData.role);
        } catch (error) {
          console.error('Error during auth state change:', error.message);
          setError(`Authentication error: ${error.message}`);
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
  }, [navigate, setUser, setRole, setPatientId, redirectUser]);

  // Clear error when user starts typing
  const handleInputChange = (setter) => (e) => {
    if (error) setError('');
    setter(e.target.value);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (isLoading) return; // Prevent multiple clicks
    setError('');
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

      console.log('API response status:', response.status, 'OK:', response.ok);
      const responseText = await response.text();
      console.log('Raw API response:', responseText);

      if (!response.ok) {
        console.error('API Error:', response.status, responseText);
        throw new Error(`HTTP error! status: ${response.status}, text: ${responseText}`);
      }

      let userData;
      try {
        userData = JSON.parse(responseText);
      } catch (parseError) {
        console.error('JSON parsing failed:', parseError.message, 'Raw response:', responseText);
        throw new Error('Failed to parse API response as JSON');
      }

      console.log('User data received from API:', userData);
      if (!userData || !userData.role) {
        console.error('Invalid user data:', userData);
        throw new Error('Invalid user data received from server, missing role');
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

      redirectUser(userData.role);
    } catch (error) {
      console.error('Login process error:', { message: error.message, code: error.code, stack: error.stack });
      if (error.code === 'auth/invalid-credential') {
        setError('Invalid email or password. Please try again.');
      } else if (error.code === 'auth/user-not-found') {
        setError('User not found. Please register first.');
      } else if (error.code === 'auth/wrong-password') {
        setError('Incorrect password. Please try again.');
      } else if (error.message.includes('HTTP error')) {
        if (error.message.includes('404')) {
          setError('User data not found on server. Please register or contact support.');
        } else {
          setError('Failed to fetch user data. Please check the server or try again later.');
        }
      } else {
        setError(`Login failed: ${error.message}`);
      }
      setParentError(`Login failed: ${error.message}`);
    } finally {
      console.log('Login process completed, isLoading set to false');
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
        <h2>Login</h2>
        <form onSubmit={handleLogin}>
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
        <p className="register-prompt">
          First Time Login?{' '}
          <span className="register-link" onClick={goToRegister}>
            Register here
          </span>
        </p>
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

        .register-prompt {
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