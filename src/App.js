// src/App.js
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
  return (
    <div className="not-found-container">
      <h2>404 - Route Not Found</h2>
      <p>The requested path <code>{window.location.pathname}</code> does not exist.</p>
      <p>Go to <a href="#" onClick={() => navigate('/login')}>Login</a></p>
      <style>{`
        .not-found-container {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          color: #fff;
          font-family: 'Arial', sans-serif;
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
        code {
          background: rgba(255, 255, 255, 0.1);
          padding: 2px 6px;
          border-radius: 4px;
        }
        a {
          color: #fff;
          text-decoration: underline;
        }
        a:hover {
          color: #e0e0e0;
        }
      `}</style>
    </div>
  );
};

function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [patientId, setPatientId] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const storedUserId = localStorage.getItem('userId');
    console.log('App.js: Stored userId from localStorage:', storedUserId);

    const unsubscribeAuth = firebaseAuth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser && storedUserId) {
        console.log(`App.js: Authenticated user detected, UID=${storedUserId}`);

        const userRef = doc(db, 'users', storedUserId);
        const unsubscribeFirestore = onSnapshot(
          userRef,
          (docSnapshot) => {
            if (docSnapshot.exists()) {
              const userData = docSnapshot.data();
              console.log('App.js: Fetched Firestore user data:', userData);

              const updatedUser = {
                uid: storedUserId,
                email: firebaseUser.email,
                ...userData,
              };

              setUser(updatedUser);
              setRole(userData.role);

              if (userData.role === 'patient') {
                const pid = userData.patientId || storedUserId;
                setPatientId(pid);
                localStorage.setItem('patientId', pid);
                console.log(`App.js: Set patientId=${pid} for patient role`);
              } else {
                setPatientId(null);
                localStorage.removeItem('patientId');
              }

              setLoading(false);
            } else {
              console.log('App.js: User document not found in Firestore');
              handleUserNotFound();
            }
          },
          (error) => {
            console.error('App.js: Firestore fetch error:', error.message);
            handleUserNotFound();
          }
        );

        return () => unsubscribeFirestore();
      } else if (user) {
        // Sync with Login.js setUser
        console.log('App.js: Syncing with Login.js user:', user);
        setRole(user.role);
        if (user.role === 'patient' && user.patientId) {
          setPatientId(user.patientId);
          localStorage.setItem('patientId', user.patientId);
        } else {
          setPatientId(null);
          localStorage.removeItem('patientId');
        }
        setLoading(false);
      } else {
        console.log('App.js: No authenticated user or stored userId');
        handleUserNotFound();
      }
    });

    return () => unsubscribeAuth();
  }, [user]); // Added user as dependency to react to Login.js updates

  const handleUserNotFound = () => {
    setUser(null);
    setRole(null);
    setPatientId(null);
    localStorage.removeItem('userId');
    localStorage.removeItem('patientId');
    setLoading(false);
    navigate('/login');
  };

  const handleLogout = async () => {
    console.log('App.js: Logging out user');
    try {
      await firebaseAuth.signOut();
      const response = await fetch(`${process.env.REACT_APP_API_URL}/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${await firebaseAuth.currentUser?.getIdToken()}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) throw new Error(`Logout failed on server: ${response.statusText}`);
      console.log('App.js: User logged out successfully');
      setUser(null);
      setRole(null);
      setPatientId(null);
      localStorage.removeItem('userId');
      localStorage.removeItem('patientId');
      navigate('/login');
    } catch (err) {
      console.error('App.js: Error during logout:', err.message);
      setUser(null);
      setRole(null);
      setPatientId(null);
      localStorage.removeItem('userId');
      localStorage.removeItem('patientId');
      navigate('/login');
    }
  };

  if (loading) {
    console.log('App.js: Rendering loading state');
    return (
      <div className="loading-container">
        <p>Loading...</p>
        <style>{`
          .loading-container {
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            background: linear-gradient(135deg, #6e48aa, #9d50bb);
            color: #fff;
            font-family: 'Arial', sans-serif;
            font-size: 1.2rem;
          }
        `}</style>
      </div>
    );
  }

  console.log('App.js: Rendering app with user:', user);
  console.log('App.js: Current role:', role);
  console.log('App.js: Current patientId:', patientId);

  return (
    <div className="app-container">
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
            />
          }
        />

        {/* Patient Routes */}
        <Route
          path="/patient/select-doctor"
          element={
            user && role === 'patient' ? (
              <SelectDoctor
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
                user={user}
                role={role}
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
        .app-container {
          min-height: 100vh;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          font-family: 'Arial', sans-serif;
        }
        a {
          color: #6e48aa;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
}

export default function AppWrapper() {
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </Router>
  );
}