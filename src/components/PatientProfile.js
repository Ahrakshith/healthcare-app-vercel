import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';
import { getAuth } from 'firebase/auth';
import './PatientProfile.css';

function PatientProfile({ user, setError }) {
  const { patientId } = useParams();
  const [patientDetails, setPatientDetails] = useState(null);
  const [patientRecords, setPatientRecords] = useState([]);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const navigate = useNavigate();
  const auth = getAuth();
  const apiBaseUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';

  const getIdToken = async () => {
    console.log('Attempting to get ID token for user:', user?.uid);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        throw new Error('No authenticated user found');
      }
      const idToken = await currentUser.getIdToken();
      console.log('ID token retrieved successfully');
      return idToken;
    } catch (error) {
      const errorMsg = `Failed to get ID token: ${error.message}`;
      setError(errorMsg);
      console.error('Get ID token error:', error);
      throw error;
    }
  };

  const fetchPatientDetails = useCallback(async () => {
    console.log('Fetching patient details for patient:', patientId);
    try {
      const patientRef = doc(db, 'patients', patientId);
      const patientDoc = await getDoc(patientRef);
      if (patientDoc.exists()) {
        setPatientDetails(patientDoc.data());
        console.log('Patient details fetched:', patientDoc.data());
      } else {
        setError('Patient not found.');
        console.error('Patient document not found');
      }
    } catch (err) {
      const errorMsg = `Failed to fetch patient details: ${err.message}`;
      setError(errorMsg);
      console.error('Fetch patient details error:', err);
    } finally {
      setLoadingDetails(false);
    }
  }, [patientId, setError]);

  const fetchPatientRecords = useCallback(async () => {
    console.log('Fetching patient records for patient:', patientId);
    if (!patientId || !user?.uid) return;

    try {
      // Step 1: Fetch all doctors assigned to this patient
      const doctorAssignmentsQuery = query(collection(db, 'doctor_assignments'), where('patientId', '==', patientId));
      const doctorAssignmentsSnapshot = await getDocs(doctorAssignmentsQuery);
      const doctorIds = doctorAssignmentsSnapshot.docs.map(doc => doc.data().doctorId);
      console.log('Doctor IDs assigned to patient:', doctorIds);

      // Step 2: Fetch doctor names for each doctorId
      const doctorNames = {};
      for (const docId of doctorIds) {
        try {
          const doctorQuery = query(collection(db, 'doctors'), where('doctorId', '==', docId));
          const doctorSnapshot = await getDocs(doctorQuery);
          if (!doctorSnapshot.empty) {
            const doctorData = doctorSnapshot.docs[0].data();
            doctorNames[docId] = doctorData.name || `Doctor ${docId}`;
            console.log(`Doctor name fetched for ${docId}:`, doctorNames[docId]);
          } else {
            doctorNames[docId] = `Doctor ${docId}`;
            console.log(`No name found for doctor ${docId}, using default name`);
          }
        } catch (err) {
          console.error(`Error fetching name for doctor ${docId}:`, err.message);
          doctorNames[docId] = `Doctor ${docId}`;
        }
      }

      // Step 3: Fetch chat messages for each doctor and extract diagnosis/prescription
      const records = [];
      const idToken = await getIdToken();

      for (const docId of doctorIds) {
        try {
          const response = await fetch(`${apiBaseUrl}/chats/${patientId}/${docId}`, {
            method: 'GET',
            headers: {
              'x-user-uid': user.uid,
              'Authorization': `Bearer ${idToken}`,
              'Content-Type': 'application/json',
            },
            credentials: 'include',
          });

          console.log(`Fetch chat messages response status for doctor ${docId}:`, response.status);
          if (!response.ok) {
            console.warn(`Failed to fetch messages for doctor ${docId}: HTTP ${response.status}`);
            continue;
          }

          const data = await response.json();
          const messages = data.messages || [];
          console.log(`Messages fetched for doctor ${docId}:`, messages.length);

          // Filter messages for diagnosis or prescription
          const doctorRecords = messages
            .filter(msg => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription))
            .map(msg => ({
              doctorId: docId,
              doctorName: doctorNames[docId],
              timestamp: msg.timestamp,
              diagnosis: msg.diagnosis || 'Not specified',
              prescription: msg.prescription
                ? (typeof msg.prescription === 'object'
                  ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration} days`
                  : msg.prescription)
                : 'None',
            }));

          records.push(...doctorRecords);
        } catch (err) {
          console.error(`Error fetching messages for doctor ${docId}:`, err.message);
        }
      }

      // Sort records by timestamp (most recent first)
      records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      console.log('Aggregated patient records:', records);
      setPatientRecords(records);
    } catch (err) {
      const errorMsg = `Error fetching patient records: ${err.message}`;
      setError(errorMsg);
      console.error('Fetch patient records error:', err);
    } finally {
      setLoadingRecords(false);
    }
  }, [patientId, user?.uid, apiBaseUrl, setError]);

  useEffect(() => {
    if (!user?.uid) {
      setError('Please log in to view patient profile.');
      navigate('/login', { replace: true });
      return;
    }
    fetchPatientDetails();
    fetchPatientRecords();
  }, [user, patientId, navigate, fetchPatientDetails, fetchPatientRecords, setError]);

  return (
    <div className="patient-profile-container">
      <div className="profile-header">
        <h2>Patient Profile</h2>
        <button
          className="close-profile-button"
          onClick={() => navigate('/doctor/chat')} // Updated to correct route
          aria-label="Close patient profile"
        >
          ✕
        </button>
      </div>
      <div className="profile-content">
        <div className="patient-details">
          <h3>Patient Details</h3>
          {loadingDetails ? (
            <p className="loading-text">Loading patient details...</p>
          ) : patientDetails ? (
            <div className="details-card">
              <p><strong>Name:</strong> {patientDetails.name || 'N/A'}</p>
              <p><strong>Patient ID:</strong> {patientId}</p>
              <p><strong>Age:</strong> {patientDetails.age || 'N/A'}</p>
              <p><strong>Sex:</strong> {patientDetails.sex || 'N/A'}</p>
              <p><strong>Registration Date:</strong> {patientDetails.registrationTimestamp ? new Date(patientDetails.registrationTimestamp).toLocaleString() : 'N/A'}</p>
              <p><strong>Language Preference:</strong> {patientDetails.languagePreference === 'kn' ? 'Kannada' : 'English'}</p>
            </div>
          ) : (
            <p className="no-data">No patient details available.</p>
          )}
        </div>
        <div className="patient-records">
          <h3>Past Diagnoses and Prescriptions</h3>
          {loadingRecords ? (
            <p className="loading-text">Loading records...</p>
          ) : patientRecords.length > 0 ? (
            <div className="records-list">
              {patientRecords.map((record, index) => (
                <div key={index} className="record-item">
                  <p><strong>Doctor Name:</strong> {record.doctorName}</p>
                  <p><strong>Doctor ID:</strong> {record.doctorId}</p>
                  <p><strong>Timestamp:</strong> {new Date(record.timestamp).toLocaleString()}</p>
                  <p><strong>Diagnosis:</strong> {record.diagnosis}</p>
                  <p><strong>Prescription:</strong> {record.prescription}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-data">No records found for this patient.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default PatientProfile;