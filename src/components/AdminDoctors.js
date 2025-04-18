// src/components/AdminDoctors.js
import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, doc, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../services/firebase.js';
import { deleteUser } from 'firebase/auth';
import { SPECIALTIES } from '../constants/specialties.js';

function AdminDoctors() {
  const [doctors, setDoctors] = useState([]);
  const [roleFilter, setRoleFilter] = useState('All');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchDoctors = async () => {
      setLoading(true);
      setError('');

      try {
        let q;
        if (roleFilter === 'All') {
          q = query(collection(db, 'doctors'));
        } else {
          q = query(collection(db, 'doctors'), where('specialty', '==', roleFilter));
        }

        const querySnapshot = await getDocs(q);
        const doctorList = querySnapshot.docs.map((doc) => ({
          doctorId: doc.id,
          ...doc.data(),
        }));

        setDoctors(doctorList);
      } catch (err) {
        console.error('AdminDoctors: Error fetching doctors:', err);
        setError(`Error fetching doctors: ${err.message}`);
        setDoctors([]);
      } finally {
        setLoading(false);
      }
    };

    fetchDoctors();
  }, [roleFilter]);

  const handleDeleteDoctor = async (doctorId) => {
    if (!window.confirm(`Are you sure you want to delete the doctor with Doctor ID ${doctorId}?`)) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Step 1: Fetch doctor's data to get UID
      const doctorDocRef = doc(db, 'doctors', doctorId);
      const doctorSnapshot = await getDocs(query(collection(db, 'doctors'), where('doctorId', '==', doctorId)));
      if (doctorSnapshot.empty) throw new Error(`Doctor with ID ${doctorId} not found in Firestore`);
      const doctorData = doctorSnapshot.docs[0].data();
      const uid = doctorData.uid;

      // Step 2: Delete from Firestore (doctors collection)
      await deleteDoc(doctorDocRef);
      console.log(`Doctor ${doctorId} deleted from Firestore (doctors)`);

      // Step 3: Delete from Firestore (users collection)
      const userDocRef = doc(db, 'users', uid);
      await deleteDoc(userDocRef);
      console.log(`Doctor ${uid} deleted from Firestore (users)`);

      // Step 4: Delete from Firebase Authentication (requires re-authentication or admin SDK)
      // Note: This step requires the user to be signed in or use Admin SDK on server-side
      // Here, we'll assume server handles auth deletion or skip it if not feasible client-side
      // Uncomment if you have proper auth setup:
      // await deleteUser(auth.currentUser); // Requires recent sign-in

      // Step 5: Delete from backend using doctorId
      const adminId = localStorage.getItem('userId');
      if (!adminId) throw new Error('Admin ID not found. Please log in again.');
      const response = await fetch(`http://localhost:5005/delete-doctor/${doctorId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': adminId, // Pass admin UID for role check
        },
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to delete doctor from backend: ${errorData.error}`);
      }

      // Step 6: Update local state
      setDoctors(doctors.filter((doctor) => doctor.doctorId !== doctorId));
      alert('Doctor deleted successfully!');
    } catch (err) {
      console.error('AdminDoctors: Error deleting doctor:', err);
      setError(`Error deleting doctor: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="table-container">
      <div className="filter-container">
        <label htmlFor="role-filter">Filter by Specialty: </label>
        <select id="role-filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
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
              <th>Doctor ID</th>
              <th>Doctor Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Experience</th>
              <th>Specialty</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {doctors.length === 0 ? (
              <tr>
                <td colSpan="7">
                  {roleFilter === 'All'
                    ? 'No doctors found.'
                    : `No doctors found for the specialty: ${roleFilter}.`}
                </td>
              </tr>
            ) : (
              doctors.map((doctor) => (
                <tr key={doctor.doctorId}>
                  <td>{doctor.doctorId}</td>
                  <td>{doctor.name}</td>
                  <td>{doctor.age}</td>
                  <td>{doctor.sex}</td>
                  <td>{doctor.experience}</td>
                  <td>{doctor.specialty}</td>
                  <td>
                    <button
                      className="delete-button"
                      onClick={() => handleDeleteDoctor(doctor.doctorId)}
                      disabled={loading}
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

        .filter-container {
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
          color: #6e48aa;
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
        }

        select:focus {
          outline: none;
          border-color: #6e48aa;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
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

        .delete-button:disabled {
          background: #999;
          cursor: not-allowed;
        }

        .delete-button:hover:not(:disabled) {
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

export default AdminDoctors;