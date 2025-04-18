// src/components/LanguagePreference.js
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db } from '../services/firebase.js';
import { doc, setDoc, getDoc } from 'firebase/firestore';

function LanguagePreference({ user, role }) {
  const { patientId, doctorId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (role !== 'patient' || !user?.uid || !patientId || !doctorId) {
      setError('Unauthorized access or missing data. Redirecting to login.');
      navigate('/login');
    }
  }, [role, user, patientId, doctorId, navigate]);

  const handleLanguageSelection = async (language) => {
    try {
      const patientRef = doc(db, 'patients', patientId);
      const patientDoc = await getDoc(patientRef);
      if (!patientDoc.exists() || patientDoc.data().uid !== user.uid) {
        setError('Patient not found or unauthorized.');
        return;
      }

      await setDoc(patientRef, { languagePreference: language }, { merge: true });
      console.log(`Language preference set to ${language} for patient ${patientId}`);
      navigate(`/patient/chat/${patientId}/${doctorId}`); // Updated to match App.js route
    } catch (err) {
      setError(`Failed to set language preference: ${err.message}`);
      console.error('Error setting language preference:', err);
    }
  };

  return (
    <div className="language-preference-container">
      <h2>Select Your Language Preference</h2>
      <p>Please choose the language you would like to use for communication:</p>
      <div className="language-options">
        <button onClick={() => handleLanguageSelection('en')} className="language-button">
          English
        </button>
        <button onClick={() => handleLanguageSelection('kn')} className="language-button">
          Kannada
        </button>
      </div>
      {error && <div className="error-message">{error}</div>}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

        .language-preference-container {
          width: 100vw;
          height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
          font-family: 'Poppins', sans-serif;
          color: #E0E0E0;
        }

        h2 {
          font-size: 2rem;
          font-weight: 600;
          color: #FFFFFF;
          margin-bottom: 20px;
          position: relative;
        }

        h2::after {
          content: '';
          width: 40px;
          height: 4px;
          background: #6E48AA;
          position: absolute;
          bottom: -10px;
          left: 50%;
          transform: translateX(-50%);
          border-radius: 2px;
        }

        p {
          font-size: 1.2rem;
          margin-bottom: 30px;
          color: #E0E0E0;
        }

        .language-options {
          display: flex;
          gap: 20px;
        }

        .language-button {
          padding: 12px 30px;
          background: rgba(255, 255, 255, 0.1);
          color: #FFFFFF;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 25px;
          font-size: 1.1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .language-button:hover {
          background: #6E48AA;
          transform: scale(1.05);
        }

        .error-message {
          color: #E74C3C;
          font-size: 0.9rem;
          margin-top: 20px;
          text-align: center;
        }
      `}</style>
    </div>
  );
}

export default LanguagePreference;