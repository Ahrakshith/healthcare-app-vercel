import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';
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
        throw new Error(errorData.error?.message || 'Recovery failed');
      }

      setSuccess('Your Patient ID has been sent to your phone number via SMS.');
    } catch (err) {
      setError(`Recovery failed: ${err.message}`);
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
  const [loginType, setLoginType] = useState('patient');
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
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          let userData;
          if (userDoc.exists()) {
            userData = userDoc.data();
          } else {
            // If not in 'users', check 'patients' collection
            const patientQuery = await getDocs(
              query(collection(db, 'patients'), where('uid', '==', firebaseUser.uid))
            );
            if (!patientQuery.empty) {
              userData = patientQuery.docs[0].data();
              userData.role = 'patient';
            } else {
              // Check 'doctors' collection
              const doctorQuery = await getDocs(
                query(collection(db, 'doctors'), where('uid', '==', firebaseUser.uid))
              );
              if (!doctorQuery.empty) {
                userData = doctorQuery.docs[0].data();
                userData.role = 'doctor';
              } else {
                throw new Error('User data not found in Firestore');
              }
            }
          }

          if (!userData.role) {
            throw new Error('Missing role in Firestore user data');
          }

          const updatedUser = {
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            role: userData.role,
            patientId: userData.patientId || null,
            name: userData.name || null,
            sex: userData.sex || null,
            age: userData.age || null,
            dateOfBirth: userData.dateOfBirth || null,
            languagePreference: userData.languagePreference || 'en',
          };

          setUser(updatedUser);
          setRole(userData.role);
          if (userData.role === 'patient' && userData.patientId) {
            setPatientId(userData.patientId);
            localStorage.setItem('patientId', userData.patientId);
          }
          localStorage.setItem('userId', firebaseUser.uid);

          // Redirect based on role
          if (userData.role === 'patient') {
            navigate('/patient/select-doctor');
          } else if (userData.role === 'doctor') {
            navigate('/doctor');
          } else if (userData.role === 'admin') {
            navigate('/admin');
          }
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
        dateOfBirth: patientData.dateOfBirth,
        languagePreference: patientData.languagePreference,
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
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address.');
      setIsLoading(false);
      return;
    }
    if (!password) {
      setError('Password is required.');
      setIsLoading(false);
      return;
    }

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;

      // Check if the user is a doctor or admin in Firestore
      const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
      let userData;
      let role;

      if (userDoc.exists()) {
        userData = userDoc.data();
        role = userData.role;
      } else {
        const doctorQuery = await getDocs(
          query(collection(db, 'doctors'), where('uid', '==', firebaseUser.uid))
        );
        if (!doctorQuery.empty) {
          userData = doctorQuery.docs[0].data();
          role = 'doctor';
        } else {
          throw new Error('User data not found in Firestore');
        }
      }

      const updatedUser = {
        uid: firebaseUser.uid,
        email,
        role: role,
        name: userData.name || null,
      };

      setUser(updatedUser);
      setRole(role);
      localStorage.setItem('userId', firebaseUser.uid);

      if (role === 'doctor') {
        navigate('/doctor');
      } else if (role === 'admin') {
        navigate('/admin');
      }
    } catch (error) {
      let errorMessage = 'Login failed. Please try again.';
      if (error.code === 'auth/invalid-credential') {
        errorMessage = 'Invalid email or password. Please try again.';
      } else if (error.code === 'auth/user-not-found') {
        errorMessage = 'User not found. Please register first.';
      } else if (error.code === 'auth/wrong-password') {
        errorMessage = 'Incorrect password. Please try again.';
      } else if (error.message.includes('User data not found')) {
        errorMessage = 'User data not found. Please contact support.';
      }
      setError(errorMessage);
      setParentError(errorMessage);
    } finally {
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
    navigate('/register');
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setRole(null);
      setPatientId(null);
      localStorage.removeItem('userId');
      localStorage.removeItem('patientId');
      navigate('/login');
    } catch (error) {
      setError('Failed to log out. Please try again.');
      setParentError('Failed to log out. Please try again.');
    }
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
                  placeholder="Enter your email address"
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
        {user && (
          <button onClick={handleLogout} className="logout-button">
            Logout
          </button>
        )}
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

        .login-button,
        .recover-button,
        .logout-button {
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
          margin-top: 10px;
        }

        .logout-button {
          background: #ff4d4d;
        }

        .login-button:disabled,
        .recover-button:disabled,
        .logout-button:disabled {
          background: #666;
          color: #A0A0A0;
          cursor: not-allowed;
        }

        .login-button:hover:not(:disabled),
        .recover-button:hover:not(:disabled) {
          transform: scale(1.05);
          background: #5A3E8B;
        }

        .logout-button:hover:not(:disabled) {
          transform: scale(1.05);
          background: #e43c3c;
        }

        .login-button::before,
        .recover-button::before,
        .logout-button::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
          transition: 0.5s;
        }

        .login-button:hover::before,
        .recover-button:hover::before,
        .logout-button:hover::before {
          left: 100%;
        }

        .recovery-prompt,
        .register-prompt {
          margin-top: 20px;
          font-size: 0.95rem;
          color: #E0E0E0;
        }

        .recovery-link,
        .register-link {
          color: #6E48AA;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.3s ease, transform 0.3s ease;
          display: inline-block;
        }

        .recovery-link:hover,
        .register-link:hover {
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