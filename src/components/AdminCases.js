// src/components/AdminCases.js
import React, { useState, useEffect } from 'react';

function AdminCases() {
  const [cases, setCases] = useState([]);
  const [patients, setPatients] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const adminId = localStorage.getItem('userId');
    if (!adminId) {
      console.error('Admin ID not found in local storage');
      setError('Admin ID not found. Please log in again.');
      return;
    }

    const fetchPatients = async () => {
      try {
        const response = await fetch('http://localhost:5005/patients');
        if (!response.ok) throw new Error('Failed to fetch patients');
        const patientList = await response.json();
        // Create a map of patientId to patient data for quick lookup
        const patientMap = patientList.reduce((map, patient) => {
          map[patient.patientId] = patient;
          return map;
        }, {});
        setPatients(patientMap);
      } catch (err) {
        console.error('AdminCases: Error fetching patients:', err);
        setError(`Error fetching patients: ${err.message}`);
      }
    };

    const fetchCases = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('http://localhost:5005/admin_notifications');
        if (!response.ok) throw new Error('Failed to fetch cases');
        const caseList = await response.json();
        setCases(caseList);
      } catch (err) {
        console.error('AdminCases: Error fetching cases:', err);
        setError(`Error fetching cases: ${err.message}`);
        setCases([]);
      } finally {
        setLoading(false);
      }
    };

    // Fetch patients first, then cases
    const initializeData = async () => {
      await fetchPatients();
      await fetchCases();
    };

    initializeData();
    const interval = setInterval(fetchCases, 5000); // Changed to 5 seconds for consistency
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="table-container">
      {error && <p className="error-message">{error}</p>}
      {loading ? (
        <p className="loading-message">Loading cases...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Patient Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Patient Description</th>
              <th>Doctor Diagnosis</th>
              <th>Prescription Given</th>
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 ? (
              <tr>
                <td colSpan="6">No cases found.</td>
              </tr>
            ) : (
              cases.map((caseItem) => {
                const patient = patients[caseItem.patientId] || {};
                return (
                  <tr key={caseItem.id}>
                    <td>{caseItem.patientName}</td>
                    <td>{patient.age || 'N/A'}</td>
                    <td>{patient.sex || 'N/A'}</td>
                    <td>{caseItem.description || 'N/A'}</td>
                    <td>{caseItem.disease || 'N/A'}</td>
                    <td className={caseItem.medicine ? '' : 'invalid-prescription'}>
                      {caseItem.medicine || 'No prescription given'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      {/* Inline CSS */}
      <style>{`
        .table-container {
          width: 100%;
          overflow-x: auto;
          padding: 20px;
          font-family: 'Poppins', sans-serif;
        }

        .error-message {
          color: #e74c3c;
          font-size: 1rem;
          margin-bottom: 20px;
          text-align: center;
        }

        .loading-message {
          color: #6e48aa;
          font-size: 1rem;
          text-align: center;
          margin-bottom: 20px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          background: #ffffff;
          border-radius: 8px;
          overflow: hidden;
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
        }

        tr:nth-child(even) {
          background: #f8f9fa;
        }

        tr:hover {
          background: #e9ecef;
        }

        .invalid-prescription {
          color: #ff4d4d;
          font-weight: 500;
        }

        @media (max-width: 768px) {
          th, td {
            padding: 10px;
            font-size: 0.9rem;
          }
        }

        @media (max-width: 480px) {
          th, td {
            padding: 8px;
            font-size: 0.8rem;
          }
        }
      `}</style>
    </div>
  );
}

export default AdminCases;