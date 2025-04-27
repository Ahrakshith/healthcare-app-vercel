import React, { useState, useEffect, useCallback, useRef } from 'react';
import { db } from '../services/firebase.js';
import { collection, getDocs, doc, deleteDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

function AdminDoctors({ refreshTrigger, refreshList }) {
  const [doctors, setDoctors] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const isMounted = useRef(true);
  const auth = getAuth();

  useEffect(() => {
    return () => {
      isMounted.current = false;
      console.log('AdminDoctors: Component unmounted');
    };
  }, []);

  const fetchDoctors = useCallback(async () => {
    if (!isMounted.current) return;

    setLoading(true);
    setError('');
    try {
      const querySnapshot = await getDocs(collection(db, 'doctors'));
      const doctorsList = querySnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      console.log('AdminDoctors: Fetched doctors:', doctorsList);
      if (isMounted.current) {
        setDoctors(doctorsList);
      }
    } catch (err) {
      console.error('AdminDoctors: Error fetching doctors:', err.message);
      if (isMounted.current) {
        setError('Failed to fetch doctors. Please try again.');
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchDoctors();
  }, [fetchDoctors, refreshTrigger]);

  const handleDeleteDoctor = useCallback(
    async (doctorId, uid) => {
      if (!isMounted.current) return;

      setError('');
      try {
        // Delete from Firestore 'doctors' collection
        await deleteDoc(doc(db, 'doctors', doctorId));
        console.log(`AdminDoctors: Doctor ${doctorId} deleted from Firestore (doctors)`);

        // Delete from Firestore 'users' collection
        await deleteDoc(doc(db, 'users', uid));
        console.log(`AdminDoctors: Doctor ${uid} deleted from Firestore (users)`);

        // Get Firebase ID token for authentication
        const idToken = await auth.currentUser?.getIdToken(true);
        if (!idToken) {
          throw new Error('Authentication token not available.');
        }

        const adminId = localStorage.getItem('userId');
        if (!adminId) {
          throw new Error('Admin ID not found. Please log in again.');
        }

        // Make API request to delete associated data (e.g., GCS files)
        const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
        const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
        const response = await fetch(`${apiUrl}/api/admin/delete-doctor`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-uid': adminId,
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ doctorId }),
          credentials: 'include',
        });

        const responseData = await response.json();
        if (!response.ok) {
          throw new Error(responseData.message || 'Failed to delete doctor data');
        }

        console.log(`AdminDoctors: Doctor ${doctorId} deleted successfully via API`);

        // Refresh the doctors list
        if (isMounted.current) {
          await fetchDoctors();
          if (refreshList) refreshList();
        }
      } catch (err) {
        console.error('AdminDoctors: Error deleting doctor:', err.message);
        if (isMounted.current) {
          setError(`Failed to delete doctor: ${err.message}`);
        }
      }
    },
    [fetchDoctors, refreshList]
  );

  return (
    <div className="admin-doctors">
      {loading && <p>Loading doctors...</p>}
      {error && <p className="error-message">{error}</p>}
      {doctors.length === 0 && !loading && !error && <p>No doctors found.</p>}
      {doctors.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Doctor ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Specialty</th>
              <th>Experience</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {doctors.map((doctor) => (
              <tr key={doctor.id}>
                <td>{doctor.doctorId}</td>
                <td>{doctor.name}</td>
                <td>{doctor.email}</td>
                <td>{doctor.specialty}</td>
                <td>{doctor.experience} years</td>
                <td>
                  <button
                    onClick={() => handleDeleteDoctor(doctor.doctorId, doctor.uid)}
                    className="delete-button"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <style>{`
        .admin-doctors {
          width: 100%;
          color: #333;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 20px;
          background: #fff;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        th, td {
          padding: 12px 15px;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }

        th {
          background: #6e48aa;
          color: #fff;
          font-weight: 600;
        }

        tr:hover {
          background: #f9f9f9;
        }

        .delete-button {
          padding: 6px 12px;
          background: #e74c3c;
          color: #fff;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 0.9rem;
          transition: background 0.3s ease;
        }

        .delete-button:hover {
          background: #c0392b;
        }

        .error-message {
          color: #e74c3c;
          font-size: 1rem;
          margin-bottom: 20px;
          text-align: center;
        }

        p {
          color: #333;
          font-size: 1rem;
          text-align: center;
        }
      `}</style>
    </div>
  );
}

export default React.memo(AdminDoctors);