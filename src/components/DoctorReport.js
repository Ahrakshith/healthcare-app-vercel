// src/components/DoctorReport.js
import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

function DoctorReport() {
  const { patientId } = useParams();
  const [patient, setPatient] = useState(null);

  useEffect(() => {
    const fetchPatient = async () => {
      try {
        const response = await fetch(`http://localhost:5005/patients/${patientId}`);
        if (!response.ok) throw new Error('Failed to fetch patient');
        const patientData = await response.json();
        setPatient(patientData);
      } catch (err) {
        console.error('DoctorReport: Error fetching patient:', err);
      }
    };
    fetchPatient();
  }, [patientId]);

  if (!patient) return <div>Loading...</div>;

  return (
    <div style={{ padding: '20px' }}>
      <h2>Patient Report: {patient.name}</h2>
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)' }}>
        <p><strong>Name:</strong> {patient.name}</p>
        <p><strong>Age:</strong> {patient.age}</p>
        <p><strong>Sex:</strong> {patient.sex}</p>
        <p><strong>Description:</strong> {patient.description || 'N/A'}</p>
        <p><strong>Diagnosis:</strong> {patient.diagnosis || 'Not Diagnosed'}</p>
        <p>
          <strong>Prescription:</strong>{' '}
          <span className={patient.prescription && !patient.prescriptionValid ? 'invalid-prescription' : ''}>
            {patient.prescription || 'Not Prescribed'}
          </span>
        </p>
        <p><strong>Suggestion:</strong> {patient.suggestion || 'N/A'}</p>
        <p><strong>Created At:</strong> {new Date(patient.createdAt).toLocaleString()}</p>
        {patient.diagnosedAt && (
          <p><strong>Diagnosed At:</strong> {new Date(patient.diagnosedAt).toLocaleString()}</p>
        )}
        {patient.prescribedAt && (
          <p><strong>Prescribed At:</strong> {new Date(patient.prescribedAt).toLocaleString()}</p>
        )}
      </div>
    </div>
  );
}

export default DoctorReport;