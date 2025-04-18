// src/components/SelectDoctor.js
import React, { useState, useEffect } from 'react';
import { SPECIALTIES } from '../constants/specialties.js';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../services/firebase.js';
import io from 'socket.io-client';

function SelectDoctor({ user, role, patientId, handleLogout }) {
  const [specialty, setSpecialty] = useState('All');
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const socketRef = React.useRef(null);

  // Initialize WebSocket connection
  useEffect(() => {
    if (!user || role !== 'patient' || !patientId) {
      console.error('SelectDoctor: Invalid user state:', { user, role, patientId });
      setError('Invalid session. Please log in again.');
      navigate('/login');
      return;
    }

    socketRef.current = io('http://localhost:5005', {
      transports: ['websocket'],
      withCredentials: true,
      extraHeaders: {
        'x-user-uid': user.uid,
      },
    });

    socketRef.current.on('connect', () => {
      console.log('SelectDoctor: WebSocket connected:', socketRef.current.id);
      socketRef.current.emit('joinRoom', `${patientId}-*`);
    });

    socketRef.current.on('connect_error', (err) => {
      console.error('SelectDoctor: WebSocket connection error:', err.message);
      setError('Real-time updates unavailable, but you can still proceed.');
    });

    socketRef.current.on('doctorAdded', (newDoctor) => {
      console.log('SelectDoctor: Received doctorAdded event:', newDoctor);
      if (!doctors.some((doc) => doc.doctorId === newDoctor.doctorId)) {
        setDoctors((prev) => [...prev, newDoctor]);
      }
    });

    socketRef.current.on('doctorDeleted', (deletedDoctorId) => {
      console.log('SelectDoctor: Received doctorDeleted event:', deletedDoctorId);
      setDoctors((prev) => prev.filter((doc) => doc.doctorId !== deletedDoctorId));
    });

    socketRef.current.on('assignmentUpdated', (assignment) => {
      console.log('SelectDoctor: Received assignment update:', assignment);
      if (assignment.patientId === patientId) {
        navigate(`/patient/language-preference/${patientId}/${assignment.doctorId}`);
      }
    });

    socketRef.current.on('disconnect', () => {
      console.log('SelectDoctor: WebSocket disconnected, attempting reconnect...');
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        console.log('SelectDoctor: WebSocket cleanup completed');
      }
    };
  }, [user, role, patientId, navigate]);

  // Fetch and listen to doctors in real-time using Firestore
  useEffect(() => {
    if (!user || role !== 'patient' || !patientId) return;

    setLoading(true);
    setError('');

    const q = specialty === 'All'
      ? query(collection(db, 'doctors'))
      : query(collection(db, 'doctors'), where('specialty', '==', specialty));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const doctorList = snapshot.docs.map((doc) => ({
        doctorId: doc.id,
        ...doc.data(),
      }));
      console.log('SelectDoctor: Real-time doctors fetched:', doctorList);
      setDoctors(doctorList);
      if (doctorList.length === 0) {
        setError(
          specialty === 'All'
            ? 'No doctors available at this time.'
            : `No doctors found for specialty: ${specialty}.`
        );
      } else {
        setError('');
      }
      setLoading(false);
    }, (err) => {
      console.error('SelectDoctor: Error with Firestore snapshot:', err);
      setError(`Failed to load doctors: ${err.message}`);
      setDoctors([]);
      setLoading(false);
    });

    return () => unsubscribe(); // Cleanup subscription
  }, [specialty, user, role, patientId]);

  // Handle doctor selection
  const handleDoctorSelect = async (doctorId) => {
    if (!patientId) {
      setError('Patient ID not found. Please log in again.');
      navigate('/login');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('http://localhost:5005/assign-doctor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': user.uid,
        },
        body: JSON.stringify({ patientId, doctorId }),
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to assign doctor');
      }

      const result = await response.json();
      console.log(`SelectDoctor: Assigned doctor ${doctorId} to patient ${patientId}`, result);

      navigate(`/patient/language-preference/${patientId}/${doctorId}`);
    } catch (err) {
      console.error('SelectDoctor: Error assigning doctor:', err);
      setError(`Error assigning doctor: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Handle logout
  const handleLogoutClick = () => {
    handleLogout();
    navigate('/login');
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
                <tr key={doctor.doctorId}>
                  <td>{doctor.name || 'N/A'}</td>
                  <td>{doctor.age || 'N/A'}</td>
                  <td>{doctor.sex || 'N/A'}</td>
                  <td>{doctor.experience || 'N/A'}</td>
                  <td>{doctor.role || 'doctor'}</td>
                  <td>{doctor.specialty || 'N/A'}</td>
                  <td>
                    <button
                      onClick={() => handleDoctorSelect(doctor.doctorId)}
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