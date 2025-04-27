// src/components/AdminPatients.js
import React, { useState, useEffect } from 'react';
import { collection, onSnapshot, doc, deleteDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';

function AdminPatients({ refreshTrigger, refreshList }) {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');

    // Set up real-time listener for the patients collection
    const unsubscribe = onSnapshot(
      collection(db, 'patients'),
      (querySnapshot) => {
        const patientList = querySnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setPatients(patientList);
        setLoading(false);
        console.log('AdminPatients: Patients updated in real-time:', patientList);
      },
      (err) => {
        console.error('AdminPatients: Error fetching patients:', err);
        setError(`Error fetching patients: ${err.message}`);
        setPatients([]);
        setLoading(false);
      }
    );

    // Cleanup subscription on unmount
    return () => unsubscribe();
  }, [refreshTrigger]); // Add refreshTrigger to dependency array to trigger re-fetch

  const handleDeletePatient = async (patientId) => {
    if (!window.confirm(`Are you sure you want to delete the patient with ID ${patientId}?`)) {
      return;
    }

    try {
      // Step 1: Delete from Firestore (patients collection)
      const patientRef = doc(db, 'patients', patientId);
      await deleteDoc(patientRef);
      console.log(`AdminPatients: Patient ${patientId} deleted from Firestore (patients)`);

      // Step 2: Delete from Firestore (users collection)
      const userRef = doc(db, 'users', patientId);
      await deleteDoc(userRef);
      console.log(`AdminPatients: Patient ${patientId} deleted from Firestore (users)`);

      // Step 3: Attempt to delete from backend (optional, non-critical step)
      const response = await fetch(`http://localhost:5005/delete-patient/${patientId}`, {
        method: 'DELETE',
        credentials: 'include', // Include credentials if your backend requires authentication
      }).catch((err) => {
        console.warn(`AdminPatients: Failed to delete patient from backend: ${err.message}`);
        return { ok: false, statusText: err.message };
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.warn(`AdminPatients: Failed to delete patient from backend: ${errorData.error || response.statusText}`);
      } else {
        console.log(`AdminPatients: Patient ${patientId} deleted from backend successfully`);
      }

      // No need to manually update state here; onSnapshot will handle it
      if (refreshList) refreshList();
      alert('Patient deleted successfully!');
    } catch (err) {
      console.error('AdminPatients: Error deleting patient:', err);
      setError(`Error deleting patient: ${err.message}`);
    }
  };

  return (
    <div className="table-container">
      {error && <p className="error-message">{error}</p>}
      {loading ? (
        <p className="loading-message">Loading patients...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Patient Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {patients.length === 0 ? (
              <tr>
                <td colSpan="4">No patients found.</td>
              </tr>
            ) : (
              patients.map((patient) => (
                <tr key={patient.id}>
                  <td>{patient.name}</td>
                  <td>{patient.age}</td>
                  <td>{patient.sex}</td>
                  <td>
                    <button
                      className="delete-button"
                      onClick={() => handleDeletePatient(patient.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
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

        .delete-button {
          padding: 5px 10px;
          background: #e74c3c;
          color: #ffffff;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 0.9rem;
          transition: background 0.3s ease;
        }

        .delete-button:hover {
          background: #c0392b;
        }

        @media (max-width: 768px) {
          th, td {
            padding: 10px;
            font-size: 0.9rem;
          }

          .delete-button {
            padding: 4px 8px;
            font-size: 0.8rem;
          }
        }

        @media (max-width: 480px) {
          th, td {
            padding: 8px;
            font-size: 0.8rem;
          }

          .delete-button {
            padding: 3px 6px;
            font-size: 0.7rem;
          }
        }
      `}</style>
    </div>
  );
}

export default AdminPatients;