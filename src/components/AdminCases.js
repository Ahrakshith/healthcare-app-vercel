import React, { useState, useEffect } from 'react';
import { auth, db } from '../services/firebase.js';
import { collection, getDocs } from 'firebase/firestore';

function AdminCases() {
  const [cases, setCases] = useState([]);
  const [patients, setPatients] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Utility function to format prescription object into a string
  const formatPrescription = (prescription) => {
    if (!prescription || typeof prescription !== 'object') {
      return 'N/A';
    }
    const { medicine, dosage, frequency, duration } = prescription;
    return [
      medicine ? `Medicine: ${medicine}` : '',
      dosage ? `Dosage: ${dosage}` : '',
      frequency ? `Frequency: ${frequency}` : '',
      duration ? `Duration: ${duration}` : '',
    ]
      .filter(Boolean)
      .join(', ');
  };

  const handleClearAll = () => {
    setCases([]);
    setError('');
  };

  useEffect(() => {
    const adminId = localStorage.getItem('userId');
    if (!adminId) {
      console.error('AdminCases: Admin ID not found in local storage');
      setError('Admin ID not found. Please log in again.');
      return;
    }

    const fetchPatients = async () => {
      try {
        const patientsSnapshot = await getDocs(collection(db, 'patients'));
        const patientMap = patientsSnapshot.docs.reduce((map, doc) => {
          const data = doc.data();
          map[data.patientId] = {
            name: data.name || 'Unknown',
            age: data.age || 'N/A',
            sex: data.sex || 'N/A',
          };
          return map;
        }, {});
        setPatients(patientMap);
      } catch (err) {
        console.error('AdminCases: Error fetching patients from Firestore:', err);
        setError(`Error fetching patient data: ${err.message}`);
      }
    };

    const fetchCases = async () => {
      setLoading(true);
      setError('');
      try {
        const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
        const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
        const idToken = await auth.currentUser?.getIdToken(true);
        if (!idToken) throw new Error('Authentication token not available');

        const response = await fetch(`${apiUrl}/api/doctors/records`, {
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'x-user-uid': adminId,
          },
        });

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          const text = await response.text();
          console.error('AdminCases: Non-JSON response received from /api/doctors/records:', {
            status: response.status,
            statusText: response.statusText,
            contentType,
            body: text.slice(0, 100),
          });
          throw new Error('Invalid response format: Expected JSON');
        }

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Failed to fetch cases: ${errorData.message || response.statusText}`);
        }

        const { records } = await response.json();
        setCases(records || []);
      } catch (err) {
        console.error('AdminCases: Error fetching cases:', err);
        setError(`Error fetching cases: ${err.message}`);
        setCases([]);
      } finally {
        setLoading(false);
      }
    };

    const initializeData = async () => {
      await fetchPatients();
      await fetchCases();
    };

    initializeData();
  }, []);

  return (
    <div className="table-container">
      <div className="table-header">
        <button onClick={handleClearAll} className="clear-all-button">
          Clear All
        </button>
      </div>
      {error && <p className="error-message">{error}</p>}
      {loading ? (
        <p className="loading-message">Loading cases...</p>
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
              <th>Prescription</th>
              <th>Valid</th>
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 ? (
              <tr>
                <td colSpan="8">No cases found.</td>
              </tr>
            ) : (
              cases.map((caseItem, index) => {
                const patient = patients[caseItem.patientId] || {};
                return (
                  <tr key={`${caseItem.doctorId}-${caseItem.patientId}-${caseItem.timestamp}-${index}`}>
                    <td>{caseItem.doctorId || 'N/A'}</td>
                    <td>{caseItem.patientId || 'N/A'}</td>
                    <td>{patient.name || 'Unknown'}</td>
                    <td>{patient.age || 'N/A'}</td>
                    <td>{patient.sex || 'N/A'}</td>
                    <td>{caseItem.diagnosis || 'N/A'}</td>
                    <td className={caseItem.valid ? '' : 'invalid-prescription'}>
                      {formatPrescription(caseItem.prescription)}
                    </td>
                    <td>{caseItem.valid ? 'Yes' : 'No'}</td>
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

        .table-header {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 10px;
        }

        .clear-all-button {
          background-color: #e74c3c;
          color: #ffffff;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1rem;
          font-family: 'Poppins', sans-serif;
          transition: background-color 0.3s;
        }

        .clear-all-button:hover {
          background-color: #c0392b;
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

          .clear-all-button {
            padding: 6px 12px;
            font-size: 0.9rem;
          }
        }

        @media (max-width: 480px) {
          th, td {
            padding: 8px;
            font-size: 0.8rem;
          }

          .clear-all-button {
            padding: 5px 10px;
            font-size: 0.8rem;
          }
        }
      `}</style>
    </div>
  );
}

export default AdminCases;