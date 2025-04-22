import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '../services/firebase.js';

function Login({ setUser, setRole, setPatientId, user }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const { username: initialUsername, password: initialPassword } = location.state || {};

  useEffect(() => {
    if (initialUsername) setEmail(initialUsername);
    if (initialPassword) setPassword(initialPassword);
  }, [initialUsername, initialPassword]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    if (!email.trim()) {
      setError('Email is required.');
      setIsLoading(false);
      return;
    }

    if (!email.endsWith('@gmail.com')) {
      setError('Please enter a valid Gmail address (e.g., example@gmail.com).');
      setIsLoading(false);
      return;
    }

    console.log('Attempting login with:', { email });

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;
      console.log('User logged in:', firebaseUser.uid);

      const response = await fetch(`${process.env.REACT_APP_API_URL}/users/${firebaseUser.uid}`, {
        headers: {
          'Authorization': `Bearer ${await firebaseUser.getIdToken()}`,
          'x-user-uid': firebaseUser.uid,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error:', response.status, errorText);
        throw new Error(`HTTP error! status: ${response.status}, text: ${errorText}`);
      }

      const userData = await response.json();
      if (!userData || !userData.role) {
        throw new Error('Invalid user data received from server');
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

      setUser(updatedUser);
      setRole(userData.role);
      if (userData.role === 'patient' && userData.patientId) {
        setPatientId(userData.patientId);
        localStorage.setItem('patientId', userData.patientId);
      }
      localStorage.setItem('userId', firebaseUser.uid);

      redirectUser(userData.role);
    } catch (error) {
      console.error('Login error:', error.message);
      if (error.code === 'auth/invalid-credential') {
        setError('Invalid email or password. Please try again.');
      } else if (error.code === 'auth/user-not-found') {
        setError('User not found. Please register first.');
      } else if (error.code === 'auth/wrong-password') {
        setError('Incorrect password. Please try again.');
      } else if (error.message.includes('HTTP error')) {
        setError('Failed to fetch user data. Please check the server or try again later.');
      } else {
        setError(`Login failed: ${error.message}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setError('');
    setIsLoggingOut(true);

    try {
      // Update to use Vercel API endpoint (assuming a logout endpoint is added later)
      const response = await fetch(`${process.env.REACT_APP_API_URL}/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${await user.getIdToken()}`,
          'x-user-uid': user.uid,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Logout API Error:', response.status, errorText);
        throw new Error(`Logout request failed: ${response.statusText}, text: ${errorText}`);
      }

      const logoutData = await response.json();
      console.log('Server logout response:', logoutData);

      await signOut(auth);

      setUser(null);
      setRole(null);
      setPatientId(null);
      localStorage.removeItem('userId');
      localStorage.removeItem('patientId');

      navigate('/login');
      console.log('User logged out successfully');
    } catch (error) {
      console.error('Logout error:', error.message);
      setError(`Failed to logout: ${error.message}`);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const redirectUser = (role) => {
    if (role === 'patient') {
      navigate('/patient/select-doctor');
    } else if (role === 'doctor') {
      navigate('/doctor');
    } else if (role === 'admin') {
      navigate('/admin');
    } else {
      navigate('/login');
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
        {user && (
          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="logout-button"
          >
            {isLoggingOut ? (
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
              'Logout'
            )}
          </button>
        )}
      </div>

      <style>{`
        .login-container {
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          padding: 20px;
          font-family: 'Arial', sans-serif;
        }

        .login-card {
          background: #fff;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
          width: 100%;
          max-width: 400px;
          text-align: center;
          animation: fadeIn 0.5s ease-in-out;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .login-card:hover {
          transform: translateY(-5px);
          box-shadow: 0 15px 40px rgba(0, 0, 0, 0.3);
        }

        h2 {
          font-size: 2.5rem;
          color: #333;
          margin-bottom: 30px;
          position: relative;
        }

        h2::after {
          content: '';
          width: 50px;
          height: 4px;
          background: #6e48aa;
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
          color: #555;
          margin-bottom: 8px;
          font-weight: 500;
        }

        input {
          width: 100%;
          padding: 12px 15px;
          border: 2px solid #ddd;
          border-radius: 8px;
          font-size: 1rem;
          color: #333;
          background: #f9f9f9;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        input:focus {
          outline: none;
          border-color: #6e48aa;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: #fff;
        }

        input::placeholder {
          color: #aaa;
        }

        .error-message {
          color: #e74c3c;
          font-size: 0.9rem;
          margin-bottom: 20px;
          animation: shake 0.5s ease;
        }

        .login-button, .logout-button {
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
        }

        .login-button {
          background: #6e48aa;
          color: #fff;
        }

        .logout-button {
          background: #e74c3c;
          color: #fff;
          margin-top: 20px;
        }

        .login-button:disabled, .logout-button:disabled {
          background: #aaa;
          cursor: not-allowed;
        }

        .login-button:hover:not(:disabled), .logout-button:hover:not(:disabled) {
          transform: scale(1.05);
        }

        .login-button:hover:not(:disabled) {
          background: #5a3e8b;
        }

        .logout-button:hover:not(:disabled) {
          background: #c0392b;
        }

        .login-button::before, .logout-button::before {
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

        .login-button:hover::before, .logout-button:hover::before {
          left: 100%;
        }

        .register-prompt {
          margin-top: 20px;
          font-size: 0.95rem;
          color: #555;
        }

        .register-link {
          color: #6e48aa;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.3s ease, transform 0.3s ease;
          display: inline-block;
        }

        .register-link:hover {
          color: #5a3e8b;
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