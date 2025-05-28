import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../services/firebase.js';


function DoctorProfile({ user, role, setError }) {
  const { doctorId } = useParams();
  const navigate = useNavigate();
  const [doctorData, setDoctorData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [updatedData, setUpdatedData] = useState({});
  const [updateError, setUpdateError] = useState('');
  const [updateSuccess, setUpdateSuccess] = useState('');

  useEffect(() => {
    console.log('DoctorProfile: Checking role and user authentication:', { role, userUid: user?.uid });
    if (role !== 'doctor' || !user?.uid) {
      const errorMsg = 'Please log in as a doctor.';
      setError(errorMsg);
      console.error(errorMsg);
      navigate('/login', { replace: true });
      return;
    }

    const fetchDoctorData = async () => {
      console.log('DoctorProfile: Fetching doctor data for doctorId:', doctorId);
      try {
        const doctorRef = doc(db, 'doctors', doctorId);
        const doctorDoc = await getDoc(doctorRef);
        if (!doctorDoc.exists()) {
          const errorMsg = 'Doctor not found.';
          setError(errorMsg);
          console.error(errorMsg);
          setLoading(false);
          return;
        }

        const data = doctorDoc.data();
        if (data.uid !== user.uid) {
          const errorMsg = 'You are not authorized to view this profile.';
          setError(errorMsg);
          console.error(errorMsg);
          navigate('/doctor-dashboard', { replace: true });
          return;
        }

        setDoctorData(data);
        setUpdatedData({
          name: data.name || '',
          age: data.age || '',
          sex: data.sex || '',
          experience: data.experience || '',
          specialty: data.specialty || '',
          qualification: data.qualification || '',
          address: data.address || '',
          contactNumber: data.contactNumber || '',
        });
        console.log('DoctorProfile: Doctor data fetched successfully:', data);
        setLoading(false);
      } catch (err) {
        const errorMsg = `Failed to fetch doctor profile: ${err.message}`;
        setError(errorMsg);
        console.error('DoctorProfile: Fetch doctor profile error:', err);
        setLoading(false);
      }
    };

    fetchDoctorData();
  }, [doctorId, role, user?.uid, navigate, setError]);

  const handleUpdateChange = (e) => {
    const { name, value } = e.target;
    setUpdatedData((prev) => ({
      ...prev,
      [name]: value,
    }));
    console.log('DoctorProfile: Updated field:', { [name]: value });
  };

  const validateContactNumber = (number) => {
    const phoneRegex = /^\d{10}$/;
    return phoneRegex.test(number);
  };

  const handleUpdateSubmit = async (e) => {
    e.preventDefault();
    console.log('DoctorProfile: Submitting updated doctor profile:', updatedData);
    setUpdateError('');
    setUpdateSuccess('');

    // Validate contact number
    if (updatedData.contactNumber && !validateContactNumber(updatedData.contactNumber)) {
      const errorMsg = 'Invalid contact number. Please enter a 10-digit number.';
      setUpdateError(errorMsg);
      console.error(errorMsg);
      return;
    }

    // Validate age and experience
    const age = parseInt(updatedData.age);
    const experience = parseInt(updatedData.experience);
    if (isNaN(age) || age < 0) {
      const errorMsg = 'Age must be a valid positive number.';
      setUpdateError(errorMsg);
      console.error(errorMsg);
      return;
    }
    if (isNaN(experience) || experience < 0) {
      const errorMsg = 'Experience must be a valid positive number.';
      setUpdateError(errorMsg);
      console.error(errorMsg);
      return;
    }

    try {
      const idToken = await auth.currentUser.getIdToken(true);
      const doctorRef = doc(db, 'doctors', doctorId);
      const updatedProfile = {
        ...doctorData,
        name: updatedData.name,
        age: updatedData.age,
        sex: updatedData.sex,
        experience: updatedData.experience,
        specialty: updatedData.specialty,
        qualification: updatedData.qualification,
        address: updatedData.address,
        contactNumber: updatedData.contactNumber,
        updatedAt: new Date().toISOString(),
      };

      await setDoc(doctorRef, updatedProfile, { merge: true });
      setDoctorData(updatedProfile);
      setEditing(false);
      setUpdateSuccess('Profile updated successfully!');
      console.log('DoctorProfile: Profile updated successfully:', updatedProfile);

      // Update doctor_assignments with the new name
      const doctorAssignmentsRef = collection(db, 'doctor_assignments');
      const q = query(doctorAssignmentsRef, where('doctorId', '==', doctorId));
      const querySnapshot = await getDocs(q);
      const batch = db.batch();
      querySnapshot.forEach((doc) => {
        batch.update(doc.ref, { doctorName: updatedData.name });
      });
      await batch.commit();
      console.log('DoctorProfile: Updated doctor name in doctor_assignments');
    } catch (err) {
      const errorMsg = `Failed to update profile: ${err.message}`;
      setUpdateError(errorMsg);
      console.error('DoctorProfile: Update profile error:', err);
    }
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setUpdatedData({
      name: doctorData.name || '',
      age: doctorData.age || '',
      sex: doctorData.sex || '',
      experience: doctorData.experience || '',
      specialty: doctorData.specialty || '',
      qualification: doctorData.qualification || '',
      address: doctorData.address || '',
      contactNumber: doctorData.contactNumber || '',
    });
    setUpdateError('');
    setUpdateSuccess('');
    console.log('DoctorProfile: Edit cancelled, reset form data');
  };

  if (loading) {
    return <div className="loading">Loading doctor profile...</div>;
  }

  if (!doctorData) {
    return <div className="error">Doctor profile not found.</div>;
  }

  return (
    <div className="doctor-profile-container">
      <h2>Doctor Profile</h2>
      {updateError && <div className="error-message">{updateError}</div>}
      {updateSuccess && <div className="success-message">{updateSuccess}</div>}
      {!editing ? (
        <div className="profile-details">
          <p><strong>Doctor ID:</strong> {doctorData.doctorId}</p>
          <p><strong>Name:</strong> {doctorData.name}</p>
          <p><strong>Email:</strong> {doctorData.email}</p>
          <p><strong>Age:</strong> {doctorData.age}</p>
          <p><strong>Sex:</strong> {doctorData.sex}</p>
          <p><strong>Experience:</strong> {doctorData.experience} years</p>
          <p><strong>Specialty:</strong> {doctorData.specialty}</p>
          <p><strong>Qualification:</strong> {doctorData.qualification}</p>
          <p><strong>Address:</strong> {doctorData.address}</p>
          <p><strong>Contact Number:</strong> {doctorData.contactNumber}</p>
          <button onClick={() => setEditing(true)} className="edit-button">
            Edit Profile
          </button>
          <button onClick={() => navigate('/doctor-dashboard')} className="back-button">
            Back to Dashboard
          </button>
        </div>
      ) : (
        <div className="edit-profile-form">
          <h3>Edit Profile</h3>
          <label>
            Name:
            <input
              type="text"
              name="name"
              value={updatedData.name}
              onChange={handleUpdateChange}
              required
            />
          </label>
          <label>
            Email:
            <input
              type="email"
              value={doctorData.email}
              disabled
            />
          </label>
          <label>
            Age:
            <input
              type="number"
              name="age"
              value={updatedData.age}
              onChange={handleUpdateChange}
              required
            />
          </label>
          <label>
            Sex:
            <select
              name="sex"
              value={updatedData.sex}
              onChange={handleUpdateChange}
              required
            >
              <option value="">Select sex</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </label>
          <label>
            Experience (Years):
            <input
              type="number"
              name="experience"
              value={updatedData.experience}
              onChange={handleUpdateChange}
              required
            />
          </label>
          <label>
            Specialty:
            <select
              name="specialty"
              value={updatedData.specialty}
              onChange={handleUpdateChange}
              required
            >
              <option value="">Select specialty</option>
              <option value="General Physician">General Physician</option>
              <option value="Cardiologist">Cardiologist</option>
              <option value="Dermatologist">Dermatologist</option>
              <option value="Pediatrician">Pediatrician</option>
              <option value="Orthopedic Surgeon">Orthopedic Surgeon</option>
            </select>
          </label>
          <label>
            Qualification:
            <input
              type="text"
              name="qualification"
              value={updatedData.qualification}
              onChange={handleUpdateChange}
              placeholder="e.g., MBBS, MD"
              required
            />
          </label>
          <label>
            Address:
            <textarea
              name="address"
              value={updatedData.address}
              onChange={handleUpdateChange}
              required
            />
          </label>
          <label>
            Contact Number:
            <input
              type="text"
              name="contactNumber"
              value={updatedData.contactNumber}
              onChange={handleUpdateChange}
              placeholder="10-digit number"
              required
            />
          </label>
          <div className="form-buttons">
            <button onClick={handleUpdateSubmit} className="save-button">
              Save Changes
            </button>
            <button onClick={handleCancelEdit} className="cancel-button">
              Cancel
            </button>
          </div>
        </div>
      )}
      <style>{`
        .doctor-profile-container {
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          font-family: 'Poppins', sans-serif;
          background: #f9f9f9;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        h2 {
          text-align: center;
          color: #6e48aa;
          margin-bottom: 20px;
        }

        h3 {
          color: #333;
          margin-bottom: 15px;
        }

        .loading, .error {
          text-align: center;
          color: #6e48aa;
          font-size: 1.1rem;
        }

        .error-message {
          color: #e74c3c;
          background: #ffebee;
          padding: 10px;
          border-radius: 4px;
          margin-bottom: 15px;
          text-align: center;
        }

        .success-message {
          color: #2ecc71;
          background: #e8f5e9;
          padding: 10px;
          border-radius: 4px;
          margin-bottom: 15px;
          text-align: center;
        }

        .profile-details p {
          font-size: 1rem;
          color: #333;
          margin: 10px 0;
        }

        .profile-details strong {
          color: #6e48aa;
        }

        .edit-profile-form {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }

        .edit-profile-form label {
          display: flex;
          flex-direction: column;
          font-size: 1rem;
          color: #333;
        }

        .edit-profile-form input,
        .edit-profile-form select,
        .edit-profile-form textarea {
          padding: 8px;
          margin-top: 5px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
          font-family: 'Poppins', sans-serif;
        }

        .edit-profile-form input:disabled {
          background: #f0f0f0;
          cursor: not-allowed;
        }

        .edit-profile-form textarea {
          resize: vertical;
          min-height: 80px;
        }

        .form-buttons,
        .profile-details {
          display: flex;
          gap: 10px;
          justify-content: center;
          margin-top: 20px;
        }

        .edit-button,
        .save-button,
        .back-button {
          background: #6e48aa;
          color: #fff;
          border: none;
          padding: 10px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1rem;
          font-family: 'Poppins', sans-serif;
          transition: background 0.3s;
        }

        .cancel-button {
          background: #e74c3c;
          color: #fff;
          border: none;
          padding: 10px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1rem;
          font-family: 'Poppins', sans-serif;
          transition: background 0.3s;
        }

        .edit-button:hover,
        .save-button:hover,
        .back-button:hover {
          background: #5a3a8b;
        }

        .cancel-button:hover {
          background: #c0392b;
        }

        @media (max-width: 480px) {
          .doctor-profile-container {
            padding: 15px;
          }

          .edit-profile-form input,
          .edit-profile-form select,
          .edit-profile-form textarea {
            font-size: 0.9rem;
          }

          .edit-button,
          .save-button,
          .cancel-button,
          .back-button {
            padding: 8px 15px;
            font-size: 0.9rem;
          }
        }
      `}</style>
    </div>
  );
}

export default DoctorProfile;