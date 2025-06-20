import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { SPECIALTIES } from '../constants/specialties.js';

function SelectDoctor({ firebaseUser, user, role, patientId, handleLogout, isLoggingOut }) {
  const [specialty, setSpecialty] = useState('All');
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(true);
  const [loadingDoctorId, setLoadingDoctorId] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const isMounted = useRef(true);

  const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
  const apiBaseUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;

  useEffect(() => {
    return () => {
      isMounted.current = false;
      console.log('SelectDoctor: Component unmounted, cleanup complete');
    };
  }, []);

  useEffect(() => {
    const authTimeout = setTimeout(() => {
      if (!firebaseUser || !user || role !== 'patient' || !patientId || isLoggingOut) {
        console.log('SelectDoctor: Invalid auth state or logging out, redirecting to /login', {
          firebaseUser: !!firebaseUser,
          user: !!user,
          role,
          patientId,
          isLoggingOut,
        });
        setError('Invalid session or logging out. Please log in again.');
        navigate('/login', { replace: true });
      } else {
        if (isMounted.current) setAuthLoading(false);
      }
    }, 500);

    return () => clearTimeout(authTimeout);
  }, [firebaseUser, user, role, patientId, isLoggingOut, navigate]);

  const fetchDoctors = useCallback(async () => {
    if (isLoggingOut || !isMounted.current) {
      console.log('SelectDoctor: Skipping fetchDoctors due to logout or unmount');
      return;
    }

    setLoading(true);
    try {
      const idToken = await firebaseUser.getIdToken(true);
      const url = `${apiBaseUrl}/api/doctors?specialty=${encodeURIComponent(specialty)}`;
      const response = await fetch(url, {
        headers: {
          'x-user-uid': user.uid,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.text();
        let errorMessage;
        try {
          const parsedError = JSON.parse(errorData);
          errorMessage = parsedError.error?.message || response.statusText;
        } catch (jsonError) {
          errorMessage = `HTTP error! status: ${response.status}, response: ${errorData}`;
        }
        throw new Error(`Failed to fetch doctors: ${errorMessage}`);
      }

      const data = await response.json();
      console.log('SelectDoctor: Doctors fetched:', data.doctors);
      if (isMounted.current) {
        setDoctors(data.doctors || []);
        setError(
          data.doctors.length === 0
            ? specialty === 'All'
              ? 'No doctors available at this time.'
              : `No doctors found for specialty: ${specialty}.`
            : ''
        );
      }
    } catch (err) {
      console.error('SelectDoctor: Fetch error:', err.message);
      if (isMounted.current) {
        if (err.message.includes('auth/user-token-expired')) {
          setError('Session expired. Please log in again.');
          navigate('/login', { replace: true });
        } else {
          setError(`Failed to load doctors: ${err.message}`);
          setDoctors([]);
        }
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [specialty, user, firebaseUser, apiBaseUrl, isLoggingOut, navigate]);

  useEffect(() => {
    if (authLoading || isLoggingOut || !isMounted.current) {
      console.log('SelectDoctor: Skipping fetchDoctors due to authLoading, logout, or unmount');
      return;
    }

    console.log('SelectDoctor: Fetching doctors for patient:', { patientId, uid: user.uid });
    fetchDoctors();

    return () => {
      console.log('SelectDoctor: Cleaning up fetchDoctors effect');
    };
  }, [fetchDoctors, authLoading, isLoggingOut, patientId, user.uid]);

  async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          const errorData = await response.text();
          let errorMessage;
          try {
            const parsedError = JSON.parse(errorData);
            errorMessage = parsedError.error?.message || response.statusText;
          } catch (jsonError) {
            errorMessage = `HTTP error! status: ${response.status}, response: ${errorData}`;
          }
          throw new Error(errorMessage);
        }
        return response;
      } catch (error) {
        if (attempt === retries || error.message.includes('auth/user-token-expired')) {
          throw error;
        }
        console.warn(`Retry ${attempt}/${retries} failed for ${url}: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
      }
    }
  }

  const handleDoctorSelect = async (doctorId) => {
    if (!patientId || !doctorId || isLoggingOut || !isMounted.current) {
      setError('Patient ID or Doctor ID not found, or logout in progress.');
      return;
    }

    setLoadingDoctorId(doctorId);
    setError('');

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetchWithRetry(`${apiBaseUrl}/api/doctors/assign`, {
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

      const result = await response.json();
      console.log(`SelectDoctor: Assigned doctor ${doctorId} to patient ${patientId}`, result);
      if (isMounted.current) {
        navigate(`/patient/language-preference/${patientId}/${doctorId}`);
      }
    } catch (err) {
      console.error('SelectDoctor: Error assigning doctor:', err.message);
      if (isMounted.current) {
        if (err.message.includes('auth/user-token-expired')) {
          setError('Session expired. Please log in again.');
          navigate('/login', { replace: true });
        } else {
          setError(
            `Error assigning doctor: ${
              err.message.includes('404')
                ? 'Doctor assignment endpoint not found. Please contact support.'
                : err.message.includes('403')
                ? 'Access denied. Please verify your role or log in again.'
                : err.message.includes('400')
                ? 'Invalid request. Please ensure all data is correct.'
                : err.message
            }`
          );
        }
      }
    } finally {
      if (isMounted.current) setLoadingDoctorId(null);
    }
  };

  const handleLogoutClick = async () => {
    if (!isMounted.current) return;

    console.log('SelectDoctor: Initiating logout via App.js handleLogout');
    try {
      await handleLogout();
      console.log('SelectDoctor: Logged out successfully');
    } catch (err) {
      console.error('SelectDoctor: Logout error:', err.message);
      if (isMounted.current) {
        setError('Failed to log out. Please try again.');
      }
    }
  };

  if (authLoading || isLoggingOut) {
    return (
      <div className="select-doctor-container">
        <p className="loading-message" role="status">
          {isLoggingOut ? 'Logging out...' : 'Loading authentication...'}
        </p>
        <style>{`
          .select-doctor-container {
            width: 100%;
            padding: 20px;
            background: linear-gradient(135deg, #6e48aa, #9d50bb);
            min-height: 100vh;
            font-family: 'Arial', sans-serif;
            box-sizing: border-box;
          }
          .loading-message {
            color: #fff;
            font-size: 1rem;
            text-align: center;
            padding: 10px;
            animation: pulse 1.5s infinite;
          }
          @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="select-doctor-container">
      <div className="header">
        <h2>Select a Doctor</h2>
        <button onClick={handleLogoutClick} className="logout-button" disabled={loading || loadingDoctorId}>
          Logout
        </button>
      </div>

      <div className="filter-container">
        <label htmlFor="specialty-filter">Filter by Specialty:</label>
        <select
          id="specialty-filter"
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          disabled={loading || loadingDoctorId}
          aria-label="Filter doctors by specialty"
        >
          <option value="All">All Specialties</option>
          {SPECIALTIES.map((spec) => (
            <option key={spec} value={spec}>
              {spec}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}
      {loading ? (
        <p className="loading-message" role="status">Loading doctors...</p>
      ) : (
        <table role="grid">
          <thead>
            <tr>
              <th scope="col">Doctor Name</th>
              <th scope="col">Age</th>
              <th scope="col">Sex</th>
              <th scope="col">Experience</th>
              <th scope="col">Role</th>
              <th scope="col">Specialty</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {doctors.length === 0 ? (
              <tr>
                <td colSpan="7" className="no-data">
                  {specialty === 'All'
                    ? 'No doctors available.'
                    : `No doctors found for specialty: ${specialty}.`}
                </td>
              </tr>
            ) : (
              doctors.map((doctor) => (
                <tr key={doctor.doctorId || doctor.id}>
                  <td>{doctor.name || 'N/A'}</td>
                  <td>{doctor.age || 'N/A'}</td>
                  <td>{doctor.sex || 'N/A'}</td>
                  <td>{doctor.experience || 'N/A'}</td>
                  <td>{doctor.role || 'doctor'}</td>
                  <td>{doctor.specialty || 'N/A'}</td>
                  <td>
                    <button
                      onClick={() => handleDoctorSelect(doctor.doctorId || doctor.id)}
                      className="select-button"
                      disabled={loading || loadingDoctorId === (doctor.doctorId || doctor.id)}
                      aria-label={`Select doctor ${doctor.name || 'N/A'}`}
                      aria-busy={loadingDoctorId === (doctor.doctorId || doctor.id) ? 'true' : 'false'}
                    >
                      {loadingDoctorId === (doctor.doctorId || doctor.id) ? 'Selecting...' : 'Select'}
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
        .no-data {
          text-align: center;
          color: #666;
          font-style: italic;
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