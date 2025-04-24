import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db } from '../services/firebase.js';
import { doc, setDoc, getDoc } from 'firebase/firestore';

// Configurable list of supported languages
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'kn', name: 'Kannada' },
  { code: 'hi', name: 'Hindi' },
];

function LanguagePreference({ user, role, firebaseUser }) {
  const { patientId, doctorId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (role !== 'patient' || !user?.uid || !patientId || !doctorId) {
      setError('Unauthorized access or missing data. Redirecting to login.');
      setTimeout(() => navigate('/login'), 2000);
    }
  }, [role, user, patientId, doctorId, navigate]);

  const handleLanguageSelection = async (languageCode) => {
    if (!firebaseUser) {
      setError('User authentication required. Please log in again.');
      setTimeout(() => navigate('/login'), 2000);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const patientRef = doc(db, 'patients', patientId);
      const patientDoc = await getDoc(patientRef);

      if (!patientDoc.exists()) {
        setError('Patient profile not found.');
        setLoading(false);
        return;
      }

      const patientData = patientDoc.data();
      if (patientData.uid !== user.uid) {
        setError('You are not authorized to update this patient profile.');
        setLoading(false);
        return;
      }

      await setDoc(patientRef, { languagePreference: languageCode }, { merge: true });
      console.log(`Language preference set to ${languageCode} for patient ${patientId}`);

      navigate(`/patient/chat/${patientId}/${doctorId}`);
    } catch (err) {
      console.error('Error setting language preference:', err);
      if (err.code === 'permission-denied') {
        setError('Permission denied. Please verify your access rights.');
      } else if (err.code === 'unavailable') {
        setError('Network error. Please check your connection and try again.');
      } else {
        setError(`Failed to set language preference: ${err.message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="language-preference-container">
      <h2>Select Your Language Preference</h2>
      <p>Please choose the language you would like to use for communication:</p>
      <div className="language-options">
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => handleLanguageSelection(lang.code)}
            className="language-button"
            disabled={loading}
          >
            {lang.name}
          </button>
        ))}
      </div>
      {error && <div className="error-message">{error}</div>}
      {loading && <div className="loading-message">Saving language preference...</div>}

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
          flex-wrap: wrap;
          justify-content: center;
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

        .language-button:hover:not(:disabled) {
          background: #6E48AA;
          transform: scale(1.05);
        }

        .language-button:disabled {
          background: rgba(255, 255, 255, 0.2);
          cursor: not-allowed;
        }

        .error-message {
          color: #E74C3C;
          font-size: 0.9rem;
          margin-top: 20px;
          text-align: center;
          padding: 10px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 5px;
        }

        .loading-message {
          color: #6E48AA;
          font-size: 0.9rem;
          margin-top: 20px;
          text-align: center;
          padding: 10px;
          animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        @media (max-width: 768px) {
          h2 {
            font-size: 1.8rem;
          }
          p {
            font-size: 1rem;
          }
          .language-button {
            padding: 10px 25px;
            font-size: 1rem;
          }
        }

        @media (max-width: 480px) {
          h2 {
            font-size: 1.5rem;
          }
          p {
            font-size: 0.9rem;
          }
          .language-options {
            flex-direction: column;
            gap: 15px;
          }
          .language-button {
            padding: 10px 20px;
            width: 100%;
            max-width: 200px;
          }
        }
      `}</style>
    </div>
  );
}

export default LanguagePreference;