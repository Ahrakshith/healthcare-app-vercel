import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../services/firebase.js';
import { SPECIALTIES } from '../constants/specialties.js';
import { signOut } from 'firebase/auth';

function SelectDoctor({ firebaseUser, user, role, patientId, handleLogout }) {
  const [specialty, setSpecialty] = useState('All');
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const apiBaseUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';

  useEffect(() => {
    if (!user || role !== 'patient' || !patientId) {
      console.error('SelectDoctor: Invalid user state:', { user, role, patientId });
      setError('Invalid session. Please log in again.');
      navigate('/login');
      return;
    }

    console.log('Fetching doctors for patient:', { patientId, uid: user.uid });

    const fetchDoctors = async () => {
      setLoading(true);
      try {
        const url = specialty === 'All' ? `${apiBaseUrl}/doctors` : `${apiBaseUrl}/doctors/by-specialty/${specialty}`;
        const response = await fetch(url, {
          headers: {
            'x-user-uid': user.uid,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          credentials: 'include',
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        const doctorList = await response.json();
        console.log('SelectDoctor: Doctors fetched:', doctorList);
        setDoctors(doctorList);
        setError(
          doctorList.length === 0
            ? specialty === 'All'
              ? 'No doctors available at this time.'
              : `No doctors found for specialty: ${specialty}.`
            : ''
        );
      } catch (err) {
        console.error('SelectDoctor: Fetch error:', err.message);
        setError(`Failed to load doctors: ${err.message}`);
        setDoctors([]);
      } finally {
        setLoading(false);
      }
    };

    fetchDoctors();
  }, [specialty, user, role, patientId, navigate, apiBaseUrl]);

  async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response;
      } catch (error) {
        if (attempt === retries) throw error;
        console.warn(`Retry ${attempt}/${retries} failed for ${url}: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
      }
    }
  }

  const handleDoctorSelect = async (doctorId) => {
    if (!patientId) {
      setError('Patient ID not found. Please log in again.');
      navigate('/login');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetchWithRetry(`${apiBaseUrl}/doctors/assign`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'x-user-uid': user.uid,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ patientId, doctorId }),
        credentials: 'include',
      });

      console.log('AssignDoctor API response status:', response.status);
      const responseText = await response.text();
      console.log('Raw AssignDoctor API response:', responseText);

      const result = JSON.parse(responseText);
      console.log(`SelectDoctor: Assigned doctor ${doctorId} to patient ${patientId}`, result);

      navigate(`/patient/language-preference/${patientId}/${doctorId}`);
    } catch (err) {
      console.error('SelectDoctor: Error assigning doctor:', err.message);
      setError(
        `Error assigning doctor: ${
          err.message.includes('404') ? 'Endpoint not found. Please contact support.' : err.message
        }`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleLogoutClick = async () => {
    try {
      await signOut(auth);
      // Optionally call the logout API for server-side cleanup
      await fetch(`${apiBaseUrl}/misc/logout`, {
        method: 'POST',
        headers: {
          'x-user-uid': user.uid,
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      handleLogout();
      navigate('/login');
      console.log('Logged out successfully');
    } catch (err) {
      console.error('Logout error:', err.message);
      setError('Failed to log out. Please try again.');
    }
  };

  return (
    <div className="select-doctor-container">
      <div className="header">
        <h2>Select a Doctor</h2>
        <button onClick={handleLogoutClick} className="logout-button" disabled={loading}>
          Logout
        </button>
      </div>

      <div className="filter-container">
        <label htmlFor="specialty-filter">Filter by Specialty:</label>
        <select
          id="specialty-filter"
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          disabled={loading}
        >
          <option value="All">All Specialties</option>
          {SPECIALTIES.map((spec) => (
            <option key={spec} value={spec}>
              {spec}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-message">{error}</p>}
      {loading ? (
        <p className="loading-message">Loading doctors...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Doctor Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Experience</th>
              <th>Role</th>
              <th>Specialty</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {doctors.length === 0 ? (
              <tr>
                <td colSpan="7">
                  {specialty === 'All'
                    ? 'No doctors available.'
                    : `No doctors found for specialty: ${specialty}.`}
                </td>
              </tr>
            ) : (
              doctors.map((doctor) => (
                <tr key={doctor.id || doctor.doctorId}>
                  <td>{doctor.name || 'N/A'}</td>
                  <td>{doctor.age || 'N/A'}</td>
                  <td>{doctor.sex || 'N/A'}</td>
                  <td>{doctor.experience || 'N/A'}</td>
                  <td>{doctor.role || 'doctor'}</td>
                  <td>{doctor.specialty || 'N/A'}</td>
                  <td>
                    <button
                      onClick={() => handleDoctorSelect(doctor.id || doctor.doctorId)}
                      className="select-button"
                      disabled={loading}
                    >
                      Select
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <style>{`
        .select-doctor-container {
          width: 100%;
          overflow-x: auto;
          padding: 20px;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          min-height: 100vh;
          font-family: 'Arial', sans-serif;
          box-sizing: border-box;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          flex-wrap: wrap;
          gap: 10px;
        }

        h2 {
          color: #fff;
          font-size: 2rem;
          margin: 0;
          text-align: center;
          flex: 1;
        }

        .logout-button {
          padding: 8px 16px;
          background: #e74c3c;
          color: #fff;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.2s ease;
        }

        .logout-button:hover:not(:disabled) {
          background: #c0392b;
          transform: scale(1.05);
        }

        .logout-button:disabled {
          background: #a0a0a0;
          cursor: not-allowed;
        }

        .filter-container {
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
          color: #fff;
          justify-content: center;
          flex-wrap: wrap;
        }

        label {
          font-size: 1.1rem;
          font-weight: 500;
        }

        select {
          padding: 8px 12px;
          border: 2px solid #ddd;
          border-radius: 8px;
          font-size: 1rem;
          color: #333;
          background: #fff;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
          min-width: 200px;
        }

        select:focus {
          outline: none;
          border-color: #6e48aa;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
        }

        select:disabled {
          background: #e0e0e0;
          cursor: not-allowed;
        }

        .error-message {
          color: #e74c3c;
          font-size: 1rem;
          margin-bottom: 20px;
          text-align: center;
          padding: 10px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 5px;
          animation: fadeIn 0.5s ease;
        }

        .loading-message {
          color: #fff;
          font-size: 1rem;
          text-align: center;
          margin-bottom: 20px;
          padding: 10px;
          animation: pulse 1.5s infinite;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          background: #ffffff;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        th, td {
          padding: 15px;
          text-align: left;
          font-size: 1rem;
          color: #333;
        }

        th {
          background: #6e48aa;
          color: #ffffff;
          font-weight: 600;
          text-transform: uppercase;
        }

        tr:nth-child(even) {
          background: #f8f9fa;
        }

        tr:hover:not(:first-child) {
          background: #e9ecef;
          transition: background 0.2s ease;
        }

        .select-button {
          padding: 8px 12px;
          background: #6e48aa;
          color: #fff;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.2s ease;
        }

        .select-button:hover:not(:disabled) {
          background: #5a3e8b;
          transform: scale(1.05);
        }

        .select-button:disabled {
          background: #a0a0a0;
          cursor: not-allowed;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        @media (max-width: 768px) {
          th, td {
            padding: 10px;
            font-size: 0.9rem;
          }
          .select-doctor-container {
            padding: 15px;
          }
          h2 {
            font-size: 1.5rem;
          }
        }

        @media (max-width: 480px) {
          th, td {
            padding: 8px;
            font-size: 0.8rem;
          }
          .filter-container {
            flex-direction: column;
            align-items: flex-start;
          }
          select {
            width: 100%;
          }
          h2 {
            font-size: 1.2rem;
          }
        }
      `}</style>
    </div>
  );
}

export default SelectDoctor;