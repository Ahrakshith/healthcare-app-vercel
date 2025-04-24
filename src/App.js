import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth as firebaseAuth, db } from './services/firebase.js';
import Login from './components/Login.js';
import Register from './components/Register.js';
import PatientChat from './components/PatientChat.js';
import DoctorChat from './components/DoctorChat.js';
import AdminDashboard from './components/AdminDashboard.js';
import SelectDoctor from './components/SelectDoctor.js';
import LanguagePreference from './components/LanguagePreference.js';
import './components/patient.css';

// Custom 404 Component
const NotFound = () => {
  return (
    <div className="not-found-container">
      <h2>404 - Page Not Found</h2>
      <p>The requested path does not exist.</p>
      <p>Go to <a href="/login">Login</a></p>
      <style>{`
        .not-found-container {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
          color: #E0E0E0;
          font-family: 'Poppins', sans-serif;
          text-align: center;
          padding: 20px;
        }
        h2 {
          font-size: 2rem;
          margin-bottom: 10px;
        }
        p {
          font-size: 1.2rem;
          margin: 5px 0;
        }
        a {
          color: #6E48AA;
          text-decoration: underline;
        }
        a:hover {
          color: #9D50BB;
        }
      `}</style>
    </div>
  );
};

function App() {
  const [firebaseUser, setFirebaseUser] = useState(null); // Firebase Auth user
  const [user, setUser] = useState(null); // Combined user data
  const [role, setRole] = useState(null);
  const [patientId, setPatientId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribeAuth = firebaseAuth.onAuthStateChanged(async (authUser) => {
      if (authUser) {
        setFirebaseUser(authUser); // Store Firebase Auth user
        const userId = authUser.uid;
        if (process.env.NODE_ENV !== 'production') {
          console.log('App.js: Authenticated user detected, UID:', userId);
        }

        const userRef = doc(db, 'users', userId);
        const unsubscribeFirestore = onSnapshot(
          userRef,
          (docSnapshot) => {
            if (docSnapshot.exists()) {
              const userData = docSnapshot.data();
              if (process.env.NODE_ENV !== 'production') {
                console.log('App.js: Fetched Firestore user data:', userData);
              }

              const updatedUser = {
                uid: userId,
                email: authUser.email,
                ...userData,
              };

              setUser(updatedUser);
              setRole(userData.role);

              if (userData.role === 'patient') {
                const pid = userData.patientId || userId;
                setPatientId(pid);
                localStorage.setItem('patientId', pid);
                if (process.env.NODE_ENV !== 'production') {
                  console.log(`App.js: Set patientId=${pid} for patient role`);
                }
              } else {
                setPatientId(null);
                localStorage.removeItem('patientId');
              }

              localStorage.setItem('userId', userId);
              setLoading(false);
            } else {
              if (process.env.NODE_ENV !== 'production') {
                console.log('App.js: User document not found in Firestore');
              }
              handleAuthFailure();
            }
          },
          (error) => {
            console.error('App.js: Firestore fetch error:', error.message);
            setError(`Failed to fetch user data: ${error.message}`);
            handleAuthFailure();
          }
        );

        return () => unsubscribeFirestore();
      } else {
        if (process.env.NODE_ENV !== 'production') {
          console.log('App.js: No authenticated user');
        }
        handleAuthFailure();
      }
    });

    return () => unsubscribeAuth();
  }, []);

  const handleAuthFailure = () => {
    setFirebaseUser(null);
    setUser(null);
    setRole(null);
    setPatientId(null);
    localStorage.removeItem('userId');
    localStorage.removeItem('patientId');
    setLoading(false);
  };

  const handleLogout = async () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('App.js: Initiating logout');
    }
    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
      const response = await fetch(`${apiUrl}/misc/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': firebaseUser?.uid || '' },
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Logout failed: ${response.statusText}`);
      }

      await firebaseAuth.signOut();
      if (process.env.NODE_ENV !== 'production') {
        console.log('App.js: User logged out successfully from Firebase');
      }

      handleAuthFailure();
    } catch (err) {
      console.error('App.js: Logout error:', err.message);
      setError(`Failed to log out: ${err.message}`);
    }
  };

  if (loading) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('App.js: Rendering loading state');
    }
    return (
      <div className="loading-container">
        <p>Loading...</p>
        <style>{`
          .loading-container {
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
            color: #E0E0E0;
            font-family: 'Poppins', sans-serif;
            font-size: 1.2rem;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="app-container">
      {error && (
        <div className="error-message">
          <span>{error}</span>
          <button onClick={() => setError('')} className="dismiss-error">
            Dismiss
          </button>
        </div>
      )}
      <Routes>
        {/* Public Routes */}
        <Route
          path="/login"
          element={
            <Login
              setUser={setUser}
              setRole={setRole}
              setPatientId={setPatientId}
              user={user}
              setError={setError}
            />
          }
        />
        <Route
          path="/register"
          element={
            <Register
              setUser={setUser}
              setRole={setRole}
              setPatientId={setPatientId}
              user={user}
              setError={setError}
            />
          }
        />

        {/* Patient Routes */}
        <Route
          path="/patient/select-doctor"
          element={
            user && role === 'patient' ? (
              <SelectDoctor
                firebaseUser={firebaseUser}
                user={user}
                role={role}
                patientId={patientId}
                handleLogout={handleLogout}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route
          path="/patient/language-preference/:patientId/:doctorId"
          element={
            user && role === 'patient' ? (
              <LanguagePreference
                firebaseUser={firebaseUser}
                user={user}
                role={role}
                patientId={patientId}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route
          path="/patient/chat/:patientId/:doctorId"
          element={
            user && role === 'patient' ? (
              <PatientChat
                firebaseUser={firebaseUser}
                user={user}
                role={role}
                patientId={patientId}
                doctorId={patientId.split('/').pop()} // Temporary fix, adjust as needed
                handleLogout={handleLogout}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Doctor Route */}
        <Route
          path="/doctor"
          element={
            user && role === 'doctor' ? (
              <DoctorChat
                user={user}
                role={role}
                handleLogout={handleLogout}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Admin Route */}
        <Route
          path="/admin"
          element={
            user && role === 'admin' ? (
              <AdminDashboard
                user={user}
                role={role}
                handleLogout={handleLogout}
                setUser={setUser}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Root Route with Role-Based Redirect */}
        <Route
          path="/"
          element={
            user ? (
              role === 'patient' ? (
                <Navigate to="/patient/select-doctor" replace />
              ) : role === 'doctor' ? (
                <Navigate to="/doctor" replace />
              ) : role === 'admin' ? (
                <Navigate to="/admin" replace />
              ) : (
                <Navigate to="/login" replace />
              )
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Fallback Route for 404 */}
        <Route path="*" element={<NotFound />} />
      </Routes>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

        .app-container {
          min-height: 100vh;
          background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
          font-family: 'Poppins', sans-serif;
        }
        a {
          color: #6E48AA;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
          color: #9D50BB;
        }
        .error-message {
          position: fixed;
          top: 20px;
          right: 20px;
          background: rgba(231, 76, 60, 0.9);
          color: #FFFFFF;
          padding: 15px 20px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          gap: 10px;
          z-index: 1000;
          font-size: 0.9rem;
          animation: slideIn 0.3s ease;
        }
        .error-message span {
          flex: 1;
        }
        .dismiss-error {
          padding: 6px 12px;
          background: #FFFFFF;
          color: #E74C3C;
          border: none;
          border-radius: 20px;
          font-size: 0.8rem;
          cursor: pointer;
          transition: background 0.3s ease;
        }
        .dismiss-error:hover {
          background: #E0E0E0;
        }
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

export default function AppWrapper() {
  return (
    <Router>
      <App />
    </Router>
  );
}