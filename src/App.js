import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth as firebaseAuth, db } from './services/firebase.js';
import { signOut } from 'firebase/auth';
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
  console.log('NotFound: Rendering 404 page');
  return (
    <div className="not-found-container">
      <h2>404 - Page Not Found</h2>
      <p>The requested path does not exist.</p>
      <p>
        Go to <a href="/login">Login</a>
      </p>
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
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [patientId, setPatientId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    console.log('App: Starting auth state listener setup');
    let unsubscribeFirestore = () => {};

    const unsubscribeAuth = firebaseAuth.onAuthStateChanged(async (authUser) => {
      console.log('App: Auth state changed, authUser:', authUser ? authUser.uid : null);
      setFirebaseUser(authUser);

      if (authUser) {
        if (process.env.NODE_ENV !== 'production') {
          console.log('App: Authenticated user detected, UID:', authUser.uid);
        }

        const userId = authUser.uid;
        console.log('App: Fetching user data for UID:', userId);
        const userRef = doc(db, 'users', userId);
        unsubscribeFirestore = onSnapshot(
          userRef,
          (docSnapshot) => {
            console.log('App: Firestore snapshot received for user:', userId);
            if (docSnapshot.exists()) {
              const userData = docSnapshot.data();
              console.log('App: Fetched Firestore user data:', userData);

              const updatedUser = {
                uid: userId,
                email: authUser.email,
                ...userData,
              };

              setUser(updatedUser);
              setRole(userData.role);
              console.log('App: Updated user state:', updatedUser, 'Role:', userData.role);

              if (userData.role === 'patient') {
                const pid = userData.patientId || userId;
                setPatientId(pid);
                sessionStorage.setItem('patientId', pid);
                console.log(`App: Set patientId=${pid} for patient role`);
              } else {
                setPatientId(null);
                sessionStorage.removeItem('patientId');
                console.log('App: Cleared patientId for non-patient role');
              }

              sessionStorage.setItem('userId', userId);
              setLoading(false);
              console.log('App: Loading complete, user data set');
            } else {
              console.log('App: User document not found in Firestore for UID:', userId);
              handleAuthFailure();
            }
          },
          (error) => {
            console.error('App: Firestore fetch error:', error.message);
            setError(`Failed to fetch user data: ${error.message}`);
            handleAuthFailure();
          }
        );
      } else {
        console.log('App: No authenticated user detected');
        handleAuthFailure();
      }
    });

    return () => {
      unsubscribeAuth();
      unsubscribeFirestore();
      console.log('App: Cleaned up auth and Firestore listeners');
    };
  }, []);

  // Clear error on route change
  useEffect(() => {
    const handleRouteChange = () => {
      if (error) {
        console.log('App: Clearing error on route change');
        setError('');
      }
    };
    window.addEventListener('popstate', handleRouteChange);
    return () => window.removeEventListener('popstate', handleRouteChange);
  }, [error]);

  const handleAuthFailure = () => {
    console.log('App: Handling auth failure, clearing all states');
    setFirebaseUser(null);
    setUser(null);
    setRole(null);
    setPatientId(null);
    sessionStorage.removeItem('userId');
    sessionStorage.removeItem('patientId');
    sessionStorage.removeItem('lastPath');
    localStorage.removeItem('patientId');
    localStorage.removeItem('userId');
    setLoading(false);
    console.log('App: Auth failure handled, loading set to false');
  };

  const handleLogout = async () => {
    console.log('App: Initiating logout process');
    try {
      let idToken = null;
      let userId = sessionStorage.getItem('userId') || '';
      if (firebaseAuth.currentUser) {
        idToken = await firebaseAuth.currentUser.getIdToken(true);
        userId = firebaseAuth.currentUser.uid;
        console.log('App: Obtained ID token for logout:', idToken ? 'Success' : 'Failed');
      } else {
        console.warn('App: No current user, skipping ID token fetch');
      }

      const apiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';

      if (userId) {
        console.log('App: Sending logout request to:', `${apiUrl}/misc/logout`);
        const response = await fetch(`${apiUrl}/misc/logout`, {
          method: 'POST',
          headers: {
            ...(idToken && { Authorization: `Bearer ${idToken}` }),
            'x-user-uid': userId,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          credentials: 'include',
        });

        console.log('App: Logout request response status:', response.status);
        if (!response.ok) {
          const errorText = await response.text();
          console.error('App: Logout request failed, details:', errorText);
          // Continue with sign-out even if API call fails
        }
      } else {
        console.warn('App: No userId available, skipping API logout request');
      }

      console.log('App: Initiating Firebase sign-out');
      await signOut(firebaseAuth);
      console.log('App: Firebase sign-out completed');

      console.log('App: Clearing app state');
      handleAuthFailure();
      console.log('App: Local state cleared successfully');
    } catch (err) {
      console.error('App: Logout error:', err.message);
      setError(`Failed to log out: ${err.message}. Redirecting to login.`);
      await signOut(firebaseAuth).catch((signOutErr) => {
        console.error('App: Firebase sign-out failed:', signOutErr.message);
      });
      handleAuthFailure();
    }
  };

  if (loading) {
    console.log('App: Rendering loading state');
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

  console.log('App: Rendering main app with user:', user?.uid, 'role:', role, 'patientId:', patientId);

  // Determine redirect path based on role
  const getRedirectPath = () => {
    if (!user || !role) return '/login';
    switch (role) {
      case 'patient':
        return '/patient/select-doctor';
      case 'doctor':
        return '/doctor/chat';
      case 'admin':
        return '/admin';
      default:
        return '/login';
    }
  };

  return (
    <div className="app-container">
      {error && (
        <div className="error-message">
          <span>{error}</span>
          <button
            onClick={() => {
              setError('');
              console.log('App: Error dismissed');
            }}
            className="dismiss-error"
          >
            Dismiss
          </button>
        </div>
      )}
      <Routes>
        <Route
          path="/login"
          element={
            user && role ? (
              <Navigate to={getRedirectPath()} replace />
            ) : (
              <Login
                setUser={setUser}
                setRole={setRole}
                setPatientId={setPatientId}
                user={user}
                setError={setError}
              />
            )
          }
        />
        <Route
          path="/register"
          element={
            user && role ? (
              <Navigate to={getRedirectPath()} replace />
            ) : (
              <Register
                setUser={setUser}
                setRole={setRole}
                setPatientId={setPatientId}
                user={user}
                setError={setError}
              />
            )
          }
        />
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
                handleLogout={handleLogout}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route
          path="/doctor/chat"
          element={
            user && role === 'doctor' ? (
              <DoctorChat user={user} role={role} handleLogout={handleLogout} setError={setError} />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route
          path="/admin"
          element={
            user && role === 'admin' ? (
              <AdminDashboard user={user} role={role} handleLogout={handleLogout} setUser={setUser} />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route
          path="/"
          element={<Navigate to={getRedirectPath()} replace />}
        />
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
  console.log('AppWrapper: Rendering Router');
  return (
    <Router>
      <App />
    </Router>
  );
}