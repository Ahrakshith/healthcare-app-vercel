import React, { useState, useEffect } from 'react';
import { auth, db } from '../services/firebase.js';
import { collection, getDocs } from 'firebase/firestore';

function AdminInvalidPrescriptions() {
  const [invalidPrescriptions, setInvalidPrescriptions] = useState([]);
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

  useEffect(() => {
    const adminId = localStorage.getItem('userId');
    if (!adminId) {
      console.error('AdminInvalidPrescriptions: Admin ID not found in local storage');
      setError('Admin ID not found. Please log in again.');
      return;
    }

    const fetchInvalidPrescriptions = async (retries = 3, backoff = 1000) => {
      setLoading(true);
      setError('');
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
          const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
          const idToken = await auth.currentUser?.getIdToken(true);
          if (!idToken) throw new Error('Authentication token not available');

          const response = await fetch(`${apiUrl}/api/admin/invalid-prescriptions`, {
            headers: {
              'Authorization': `Bearer ${idToken}`,
              'x-user-uid': adminId,
            },
          });

          const contentType = response.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('AdminInvalidPrescriptions: Non-JSON response received:', {
              status: response.status,
              statusText: response.statusText,
              contentType,
              body: text.slice(0, 100),
            });
            throw new Error('Invalid response format: Expected JSON');
          }

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to fetch invalid prescriptions: ${errorData.message || response.statusText}`);
          }

          const data = await response.json();
          setInvalidPrescriptions(data.invalidPrescriptions || []);
          break; // Success, exit retry loop
        } catch (err) {
          console.error(`AdminInvalidPrescriptions: Error fetching invalid prescriptions (attempt ${attempt}/${retries}):`, err);
          if (attempt === retries) {
            setError(`Error fetching invalid prescriptions: ${err.message}`);
            setInvalidPrescriptions([]);
          } else {
            const delay = backoff * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } finally {
          if (attempt === retries || !error) setLoading(false);
        }
      }
    };

    const fetchPatients = async () => {
      try {
        const patientsSnapshot = await getDocs(collection(db, 'patients'));
        const patientMap = patientsSnapshot.docs.reduce((map, doc) => {
          const data = doc.data();
          map[data.patientId] = data;
          return map;
        }, {});
        setPatients(patientMap);
      } catch (err) {
        console.error('AdminInvalidPrescriptions: Error fetching patients from Firestore:', err);
        setError((prev) => prev || `Error fetching patient data: ${err.message}`);
      }
    };

    const initializeData = async () => {
      await fetchPatients();
      await fetchInvalidPrescriptions();
    };

    initializeData();
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
              <th>Diagnosis</th>
              <th>Prescription</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {invalidPrescriptions.length === 0 ? (
              <tr>
                <td colSpan="6">No invalid prescriptions found.</td>
              </tr>
            ) : (
              invalidPrescriptions.map((record, index) => {
                const patient = patients[record.patientId] || {};
                return (
                  <tr key={`${record.doctorId}-${record.patientId}-${record.timestamp}-${index}`}>
                    <td>{record.doctorId || 'N/A'}</td>
                    <td>{record.patientId || 'N/A'}</td>
                    <td>{patient.name || 'Unknown'}</td>
                    <td>{record.diagnosis || 'N/A'}</td>
                    <td className="invalid-prescription">{formatPrescription(record.prescription)}</td>
                    <td>{new Date(record.timestamp).toLocaleString() || 'N/A'}</td>
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