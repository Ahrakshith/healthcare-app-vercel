import React, { useState, useEffect } from 'react';
import { auth } from '../services/firebase.js';

function AdminInvalidPrescriptions() {
  const [invalidPrescriptions, setInvalidPrescriptions] = useState([]);
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
        const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
        const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
        const idToken = await auth.currentUser?.getIdToken(true);
        const response = await fetch(`${apiUrl}/api/patients`, {
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'x-user-uid': adminId,
          },
        });
        if (!response.ok) throw new Error('Failed to fetch patients');
        const patientList = await response.json();
        // Create a map of patientId to patient data for quick lookup
        const patientMap = patientList.reduce((map, patient) => {
          map[patient.patientId] = patient;
          return map;
        }, {});
        setPatients(patientMap);
      } catch (err) {
        console.error('AdminInvalidPrescriptions: Error fetching patients:', err);
        setError(`Error fetching patients: ${err.message}`);
      }
    };

    const fetchInvalidPrescriptions = async () => {
      setLoading(true);
      setError('');
      try {
        const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
        const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
        const idToken = await auth.currentUser?.getIdToken(true);
        const response = await fetch(`${apiUrl}/api/admin/invalid-prescriptions`, {
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'x-user-uid': adminId,
          },
        });
        if (!response.ok) throw new Error('Failed to fetch invalid prescriptions');
        const { invalidPrescriptions } = await response.json();
        setInvalidPrescriptions(invalidPrescriptions);
      } catch (err) {
        console.error('AdminInvalidPrescriptions: Error fetching invalid prescriptions:', err);
        setError(`Error fetching invalid prescriptions: ${err.message}`);
        setInvalidPrescriptions([]);
      } finally {
        setLoading(false);
      }
    };

    // Fetch patients first, then invalid prescriptions
    const initializeData = async () => {
      await fetchPatients();
      await fetchInvalidPrescriptions();
    };

    initializeData();
    const interval = setInterval(fetchInvalidPrescriptions, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="table-container">
      {error && <p className="error-message">{error}</p>}
      {loading ? (
        <p className="loading-message">Loading invalid prescriptions...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Doctor ID</th>
              <th>Patient ID</th>
              <th>Patient Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Diagnosis</th>
              <th>Invalid Prescription</th>
            </tr>
          </thead>
          <tbody>
            {invalidPrescriptions.length === 0 ? (
              <tr>
                <td colSpan="7">No invalid prescriptions found.</td>
              </tr>
            ) : (
              invalidPrescriptions.map((prescription, index) => {
                const patient = patients[prescription.patientId] || {};
                return (
                  <tr key={`${prescription.doctorId}-${prescription.patientId}-${prescription.timestamp}-${index}`}>
                    <td>{prescription.doctorId}</td>
                    <td>{prescription.patientId}</td>
                    <td>{patient.name || 'N/A'}</td>
                    <td>{patient.age || 'N/A'}</td>
                    <td>{patient.sex || 'N/A'}</td>
                    <td>{prescription.diagnosis}</td>
                    <td className="invalid-prescription">{prescription.prescription}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

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

export default AdminInvalidPrescriptions;