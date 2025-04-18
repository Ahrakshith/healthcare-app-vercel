// src/components/DoctorSelection.js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SPECIALTIES } from '../constants/specialties'; // Import the shared specialties

function DoctorSelection({ user, setUser }) {
  const [specialty, setSpecialty] = useState('');
  const [doctors, setDoctors] = useState([]);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!user || user.role !== 'patient') {
      setError('You must be logged in as a patient to access this page.');
      navigate('/login');
      return;
    }

    const fetchDoctors = async () => {
      if (!specialty) {
        setDoctors([]);
        return;
      }

      try {
        const response = await fetch(`http://localhost:5005/doctors-by-specialty/${specialty}`);
        if (!response.ok) throw new Error('Failed to fetch doctors');
        const doctorList = await response.json();
        setDoctors(doctorList);
      } catch (err) {
        setError(`Error fetching doctors: ${err.message}`);
        setDoctors([]);
      }
    };

    fetchDoctors();
  }, [specialty, user, navigate]);

  const handleSelectDoctor = (doctorId) => {
    navigate(`/patient/chat/${user.uid}/${doctorId}`);
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('userId');
    navigate('/login');
  };

  return (
    <div className="doctor-selection-container">
      <div className="doctor-selection-card">
        <h2>Select a Doctor</h2>
        {error && <p className="error-message">{error}</p>}
        <div className="form-group">
          <label htmlFor="specialty">Specialty</label>
          <select
            id="specialty"
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
          >
            <option value="" disabled>Select a specialty</option>
            {SPECIALTIES.map((spec) => (
              <option key={spec} value={spec}>{spec}</option>
            ))}
          </select>
        </div>
        {specialty && (
          <div className="doctors-list">
            <h3>Available Doctors</h3>
            {doctors.length === 0 ? (
              <p>No doctors available for this specialty.</p>
            ) : (
              <ul>
                {doctors.map((doctor) => (
                  <li key={doctor.id}>
                    <span>{doctor.name} (Experience: {doctor.experience} years)</span>
                    <button
                      onClick={() => handleSelectDoctor(doctor.id)}
                      className="select-button"
                    >
                      Select
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button onClick={handleLogout} className="logout-button">
          Logout
        </button>
      </div>

      {/* Inline CSS */}
      <style>{`
        .doctor-selection-container {
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          padding: 20px;
          font-family: 'Arial', sans-serif;
        }

        .doctor-selection-card {
          background: #fff;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
          width: 100%;
          max-width: 500px;
          text-align: center;
          animation: fadeIn 0.5s ease-in-out;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .doctor-selection-card:hover {
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

        h3 {
          font-size: 1.5rem;
          color: #6e48aa;
          margin-bottom: 20px;
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

        select {
          width: 100%;
          padding: 12px 15px;
          border: 2px solid #ddd;
          border-radius: 8px;
          font-size: 1rem;
          color: #333;
          background: #f9f9f9;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        select:focus {
          outline: none;
          border-color: #6e48aa;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: #fff;
        }

        .error-message {
          color: #e74c3c;
          font-size: 0.9rem;
          margin-bottom: 20px;
          animation: shake 0.5s ease;
        }

        .doctors-list {
          margin-top: 20px;
        }

        ul {
          list-style: none;
          padding: 0;
        }

        li {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px;
          background: #f9f9f9;
          border-radius: 8px;
          margin-bottom: 10px;
          transition: background 0.3s ease;
        }

        li:hover {
          background: #e9ecef;
        }

        .select-button {
          padding: 8px 20px;
          background: #6e48aa;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .select-button:hover {
          background: #5a3e8b;
          transform: scale(1.05);
        }

        .logout-button {
          width: 100%;
          padding: 12px;
          background: #e74c3c;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1.1rem;
          font-weight: 600;
          margin-top: 20px;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .logout-button:hover {
          background: #c0392b;
          transform: scale(1.05);
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
      `}</style>
    </div>
  );
}

export default DoctorSelection;