// src/components/DoctorTable.js
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

function DoctorTable() {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const doctorId = localStorage.getItem('userId');
    if (!doctorId) {
      setError('Doctor ID not found. Please log in again.');
      setLoading(false);
      return;
    }

    const fetchPatients = async () => {
      try {
        const response = await fetch('http://localhost:5005/patients');
        if (!response.ok) throw new Error('Failed to fetch patients');
        const patientList = await response.json();
        setPatients(patientList);
        setLoading(false);
      } catch (err) {
        setError('Failed to load patients: ' + err.message);
        setLoading(false);
      }
    };

    fetchPatients();
  }, []);

  if (loading) return <div>Loading patients...</div>;
  if (error) return <div style={{ color: 'red' }}>{error}</div>;

  return (
    <div className="table-container" style={{ padding: '20px' }}>
      {/* Rest of your JSX remains unchanged */}
    </div>
  );
}

export default DoctorTable;