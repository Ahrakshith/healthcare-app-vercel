// src/components/AdminDashboard.js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminDoctors from './AdminDoctors.js';
import AdminPatients from './AdminPatients.js';
import AdminCases from './AdminCases.js';
import { SPECIALTIES } from '../constants/specialties.js';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc, getDocs, query, collection, where } from 'firebase/firestore';
import { auth, db } from '../services/firebase.js';

function AdminDashboard({ user, role, handleLogout, setUser }) { // Added setUser as a prop
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentView, setCurrentView] = useState('add-doctor');
  const [showAddForm, setShowAddForm] = useState(true);
  const [newDoctor, setNewDoctor] = useState({
    name: '',
    age: '',
    sex: '',
    experience: '',
    specialty: SPECIALTIES[0],
    email: '',
    password: '',
    doctorId: '',
    qualification: '',
    address: '',
    contactNumber: '',
  });
  const [addDoctorError, setAddDoctorError] = useState('');
  const [addDoctorSuccess, setAddDoctorSuccess] = useState('');
  const [newAdmin, setNewAdmin] = useState({
    email: '',
    password: '',
  });
  const [addAdminError, setAddAdminError] = useState('');
  const [addAdminSuccess, setAddAdminSuccess] = useState('');
  const [isAddingAdmin, setIsAddingAdmin] = useState(false);
  const navigate = useNavigate();

  // Generate a unique 6-character alphanumeric doctorId
  const generateDoctorId = async () => {
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let generatedId = '';
    const doctorIdsRef = collection(db, 'doctors');

    while (true) {
      generatedId = '';
      for (let i = 0; i < 6; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        generatedId += characters[randomIndex];
      }

      const q = query(doctorIdsRef, where('doctorId', '==', generatedId));
      const querySnapshot = await getDocs(q);
      if (querySnapshot.empty) break;
      console.log(`Generated doctorId ${generatedId} already exists, regenerating...`);
    }

    console.log('AdminDashboard.js: Generated unique doctorId:', generatedId);
    return generatedId;
  };

  useEffect(() => {
    if (!user || role !== 'admin') {
      navigate('/login');
    }
    generateDoctorId()
      .then((uniqueId) => {
        setNewDoctor((prev) => ({ ...prev, doctorId: uniqueId }));
      })
      .catch((err) => {
        console.error('AdminDashboard.js: Error generating doctorId:', err);
        setAddDoctorError('Failed to generate doctor ID. Please try again.');
      });
  }, [user, role, navigate]);

  const toggleMenu = () => {
    setMenuOpen(!menuOpen);
  };

  const handleViewChange = (view) => {
    setCurrentView(view);
    setMenuOpen(false);
    if (view === 'add-doctor') {
      setShowAddForm(true);
      setAddDoctorSuccess('');
      setAddDoctorError('');
      generateDoctorId().then((uniqueId) => {
        setNewDoctor((prev) => ({ ...prev, doctorId: uniqueId }));
      });
    }
  };

  const handleDoctorInputChange = (e) => {
    const { name, value } = e.target;
    setNewDoctor((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddDoctor = async (e) => {
    e.preventDefault();
    setAddDoctorError('');
    setAddDoctorSuccess('');

    const adminId = localStorage.getItem('userId');
    console.log('AdminDashboard: Admin UID from localStorage:', adminId);
    if (!adminId) {
      setAddDoctorError('Admin ID not found. Please log in again.');
      return;
    }

    if (
      !newDoctor.name ||
      !newDoctor.age ||
      !newDoctor.sex ||
      !newDoctor.experience ||
      !newDoctor.specialty ||
      !newDoctor.email ||
      !newDoctor.password ||
      !newDoctor.doctorId ||
      !newDoctor.qualification ||
      !newDoctor.address ||
      !newDoctor.contactNumber
    ) {
      setAddDoctorError('Please fill in all fields.');
      return;
    }

    if (!newDoctor.email.endsWith('@gmail.com')) {
      setAddDoctorError('Email must be a valid Gmail address (e.g., example@gmail.com).');
      return;
    }

    if (isNaN(newDoctor.age) || newDoctor.age <= 0) {
      setAddDoctorError('Please enter a valid age.');
      return;
    }

    if (isNaN(newDoctor.experience) || newDoctor.experience < 0) {
      setAddDoctorError('Please enter a valid experience (in years).');
      return;
    }

    if (!/^\d{10}$/.test(newDoctor.contactNumber)) {
      setAddDoctorError('Please enter a valid 10-digit contact number.');
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, newDoctor.email, newDoctor.password);
      const firebaseUser = userCredential.user;
      console.log('AdminDashboard: Doctor registered in Firebase Auth:', firebaseUser.uid);

      const userDocRef = doc(db, 'users', firebaseUser.uid);
      const userData = {
        uid: firebaseUser.uid,
        email: newDoctor.email,
        role: 'doctor',
        name: newDoctor.name,
        age: parseInt(newDoctor.age),
        sex: newDoctor.sex,
        experience: parseInt(newDoctor.experience),
        specialty: newDoctor.specialty,
        doctorId: newDoctor.doctorId,
        qualification: newDoctor.qualification,
        address: newDoctor.address,
        contactNumber: newDoctor.contactNumber,
        createdAt: new Date().toISOString(),
      };
      await setDoc(userDocRef, userData);
      console.log('AdminDashboard: Doctor data stored in Firestore (users):', firebaseUser.uid);

      const doctorDocRef = doc(db, 'doctors', newDoctor.doctorId);
      const doctorData = {
        uid: firebaseUser.uid,
        name: newDoctor.name,
        age: parseInt(newDoctor.age),
        sex: newDoctor.sex,
        experience: parseInt(newDoctor.experience),
        specialty: newDoctor.specialty,
        doctorId: newDoctor.doctorId,
        qualification: newDoctor.qualification,
        address: newDoctor.address,
        contactNumber: newDoctor.contactNumber,
        createdAt: new Date().toISOString(),
      };
      await setDoc(doctorDocRef, doctorData);
      console.log('AdminDashboard: Doctor data stored in Firestore (doctors):', newDoctor.doctorId);

      console.log('AdminDashboard: Sending request to /add-doctor with x-user-uid:', adminId);
      const response = await fetch('http://localhost:5005/add-doctor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': adminId,
          'Authorization': `Bearer ${await auth.currentUser.getIdToken()}`,
        },
        body: JSON.stringify({
          id: newDoctor.doctorId,
          name: newDoctor.name,
          age: newDoctor.age,
          sex: newDoctor.sex,
          experience: newDoctor.experience,
          specialty: newDoctor.specialty,
          qualification: newDoctor.qualification,
          address: newDoctor.address,
          contactNumber: newDoctor.contactNumber,
          createdAt: new Date().toISOString(),
          uid: firebaseUser.uid,
        }),
        credentials: 'include',
      });

      const responseData = await response.json();
      if (!response.ok) {
        throw new Error(`Failed to add doctor to backend: ${responseData.error}`);
      }

      console.log('AdminDashboard: Doctor added to backend successfully:', responseData);
      setAddDoctorSuccess('Doctor added successfully!');
      setNewDoctor({
        name: '',
        age: '',
        sex: '',
        experience: '',
        specialty: SPECIALTIES[0],
        email: '',
        password: '',
        doctorId: await generateDoctorId(),
        qualification: '',
        address: '',
        contactNumber: '',
      });
      setShowAddForm(false);
    } catch (err) {
      console.error('AdminDashboard: Error adding doctor:', err);
      if (err.code === 'auth/email-already-in-use') {
        setAddDoctorError('This email is already registered.');
      } else if (err.code === 'auth/invalid-email') {
        setAddDoctorError('Please enter a valid Gmail address (e.g., example@gmail.com).');
      } else if (err.code === 'auth/weak-password') {
        setAddDoctorError('Password should be at least 6 characters long.');
      } else {
        setAddDoctorError(`Error adding doctor: ${err.message}`);
      }
    }
  };

  const handleAdminInputChange = (e) => {
    const { name, value } = e.target;
    setNewAdmin((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddAdmin = async (e) => {
    e.preventDefault();
    setAddAdminError('');
    setAddAdminSuccess('');
    setIsAddingAdmin(true);

    if (!newAdmin.email || !newAdmin.password) {
      setAddAdminError('Please fill in all fields.');
      setIsAddingAdmin(false);
      return;
    }

    if (!newAdmin.email.endsWith('@gmail.com')) {
      setAddAdminError('Email must be a valid Gmail address (e.g., example@gmail.com).');
      setIsAddingAdmin(false);
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, newAdmin.email, newAdmin.password);
      const firebaseUser = userCredential.user;
      console.log('AdminDashboard: New admin registered in Firebase Auth:', firebaseUser.uid);

      const userDocRef = doc(db, 'users', firebaseUser.uid);
      const userData = {
        uid: firebaseUser.uid,
        email: newAdmin.email,
        role: 'admin',
        createdAt: new Date().toISOString(),
      };

      await setDoc(userDocRef, userData);
      console.log('AdminDashboard: Admin data stored in Firestore:', firebaseUser.uid);

      setAddAdminSuccess('Admin added successfully!');
      setNewAdmin({ email: '', password: '' });
    } catch (error) {
      console.error('AdminDashboard: Add admin error:', error);
      if (error.code === 'auth/email-already-in-use') {
        setAddAdminError('This email is already registered.');
      } else if (error.code === 'auth/invalid-email') {
        setAddAdminError('Please enter a valid Gmail address (e.g., example@gmail.com).');
      } else if (error.code === 'auth/weak-password') {
        setAddAdminError('Password should be at least 6 characters long.');
      } else {
        setAddAdminError(`Failed to add admin: ${error.message}`);
      }
    } finally {
      setIsAddingAdmin(false);
    }
  };

  return (
    <div className="admin-dashboard">
      <div className="header">
        <button className="hamburger-button" onClick={toggleMenu}>
          {menuOpen ? '✖' : '☰'}
        </button>
        <h2>Admin Dashboard</h2>
        <p>Welcome, Admin! (UID: {user?.uid})</p>
      </div>

      <div className={`menu ${menuOpen ? 'open' : ''}`}>
        <ul>
          <li className={currentView === 'add-doctor' ? 'active' : ''} onClick={() => handleViewChange('add-doctor')}>
            Add Doctor
          </li>
          <li className={currentView === 'add-admin' ? 'active' : ''} onClick={() => handleViewChange('add-admin')}>
            Add Admin
          </li>
          <li className={currentView === 'doctors' ? 'active' : ''} onClick={() => handleViewChange('doctors')}>
            Doctors List
          </li>
          <li className={currentView === 'patients' ? 'active' : ''} onClick={() => handleViewChange('patients')}>
            Patients List
          </li>
          <li className={currentView === 'cases' ? 'active' : ''} onClick={() => handleViewChange('cases')}>
            Cases List
          </li>
          <li onClick={handleLogout}>Logout</li>
        </ul>
      </div>

      <div className="content">
        {currentView === 'add-doctor' && (
          <div className="section">
            <div className="add-doctor-form">
              <h3>Add New Doctor</h3>
              {showAddForm ? (
                <form onSubmit={handleAddDoctor}>
                  <div className="form-group">
                    <label htmlFor="doctorId">Doctor ID</label>
                    <input
                      type="text"
                      id="doctorId"
                      name="doctorId"
                      value={newDoctor.doctorId}
                      readOnly
                      placeholder="Auto-generated Doctor ID"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="email">Email</label>
                    <input
                      type="email"
                      id="email"
                      name="email"
                      value={newDoctor.email}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter doctor email (e.g., doctor@gmail.com)"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="password">Password</label>
                    <input
                      type="password"
                      id="password"
                      name="password"
                      value={newDoctor.password}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter doctor password"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="name">Doctor Name</label>
                    <input
                      type="text"
                      id="name"
                      name="name"
                      value={newDoctor.name}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter doctor name"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="age">Age</label>
                    <input
                      type="number"
                      id="age"
                      name="age"
                      value={newDoctor.age}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter age"
                      required
                      min="1"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="sex">Sex</label>
                    <select id="sex" name="sex" value={newDoctor.sex} onChange={handleDoctorInputChange} required>
                      <option value="" disabled>Select sex</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="experience">Experience (Years)</label>
                    <input
                      type="number"
                      id="experience"
                      name="experience"
                      value={newDoctor.experience}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter years of experience"
                      required
                      min="0"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="specialty">Specialty</label>
                    <select
                      id="specialty"
                      name="specialty"
                      value={newDoctor.specialty}
                      onChange={handleDoctorInputChange}
                      required
                    >
                      <option value="" disabled>Select specialty</option>
                      {SPECIALTIES.map((spec) => (
                        <option key={spec} value={spec}>
                          {spec}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="qualification">Qualification</label>
                    <input
                      type="text"
                      id="qualification"
                      name="qualification"
                      value={newDoctor.qualification}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter qualification (e.g., MBBS, MD)"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="address">Address</label>
                    <input
                      type="text"
                      id="address"
                      name="address"
                      value={newDoctor.address}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter address"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="contactNumber">Contact Number</label>
                    <input
                      type="text"
                      id="contactNumber"
                      name="contactNumber"
                      value={newDoctor.contactNumber}
                      onChange={handleDoctorInputChange}
                      placeholder="Enter 10-digit contact number"
                      required
                      maxLength="10"
                    />
                  </div>
                  {addDoctorError && <p className="error-message">{addDoctorError}</p>}
                  {addDoctorSuccess && <p className="success-message">{addDoctorSuccess}</p>}
                  <button type="submit" className="submit-button">
                    Add Doctor
                  </button>
                </form>
              ) : (
                <div className="success-container">
                  <p className="success-message">{addDoctorSuccess}</p>
                  <button
                    onClick={() => {
                      setShowAddForm(true);
                      setAddDoctorSuccess('');
                      generateDoctorId().then((uniqueId) => {
                        setNewDoctor((prev) => ({ ...prev, doctorId: uniqueId }));
                      });
                    }}
                    className="submit-button"
                  >
                    Add Another Doctor
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {currentView === 'add-admin' && (
          <div className="section">
            <div className="add-admin-form">
              <h3>Add New Admin</h3>
              <form onSubmit={handleAddAdmin}>
                <div className="form-group">
                  <label htmlFor="admin-email">Email</label>
                  <input
                    type="email"
                    id="admin-email"
                    name="email"
                    value={newAdmin.email}
                    onChange={handleAdminInputChange}
                    placeholder="Enter admin email (e.g., admin@gmail.com)"
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="admin-password">Password</label>
                  <input
                    type="password"
                    id="admin-password"
                    name="password"
                    value={newAdmin.password}
                    onChange={handleAdminInputChange}
                    placeholder="Enter admin password"
                    required
                  />
                </div>
                {addAdminError && <p className="error-message">{addAdminError}</p>}
                {addAdminSuccess && <p className="success-message">{addAdminSuccess}</p>}
                <button type="submit" disabled={isAddingAdmin} className="submit-button">
                  {isAddingAdmin ? 'Adding Admin...' : 'Add Admin'}
                </button>
              </form>
            </div>
          </div>
        )}

        {currentView === 'doctors' && (
          <div className="section">
            <h3>Doctors List</h3>
            <AdminDoctors />
          </div>
        )}

        {currentView === 'patients' && (
          <div className="section">
            <h3>Patients List</h3>
            <AdminPatients />
          </div>
        )}

        {currentView === 'cases' && (
          <div className="section">
            <h3>Cases List</h3>
            <AdminCases />
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap');

        .admin-dashboard {
          min-height: 100vh;
          width: 100vw;
          background: linear-gradient(135deg, #6e48aa, #9d50bb);
          font-family: 'Poppins', sans-serif;
          padding: 40px;
          color: #ffffff;
          overflow-y: auto;
          position: relative;
        }

        .header {
          text-align: center;
          margin-bottom: 20px;
        }

        .hamburger-button {
          position: absolute;
          top: 20px;
          left: 20px;
          background: none;
          border: none;
          font-size: 2rem;
          color: #ffffff;
          cursor: pointer;
          z-index: 1000;
        }

        .menu {
          position: fixed;
          top: 0;
          left: -250px;
          width: 250px;
          height: 100%;
          background: #ffffff;
          box-shadow: 2px 0 5px rgba(0, 0, 0, 0.2);
          transition: left 0.3s ease;
          z-index: 999;
        }

        .menu.open {
          left: 0;
        }

        .menu ul {
          list-style: none;
          padding: 60px 20px 20px;
        }

        .menu li {
          padding: 15px;
          font-size: 1.2rem;
          color: #6e48aa;
          cursor: pointer;
          transition: background 0.3s ease;
        }

        .menu li:hover {
          background: #f0f0f0;
        }

        .menu li.active {
          background: #6e48aa;
          color: #ffffff;
          border-radius: 5px;
        }

        h2 {
          font-size: 2rem;
          font-weight: 600;
          margin-bottom: 10px;
        }

        p {
          font-size: 1.1rem;
          margin-bottom: 20px;
        }

        .content {
          margin-left: 0;
          transition: margin-left 0.3s ease;
        }

        .section {
          background: #ffffff;
          border-radius: 10px;
          padding: 30px;
          margin-bottom: 30px;
          box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        }

        .section h3 {
          font-size: 1.5rem;
          font-weight: 600;
          margin-bottom: 20px;
          color: #6e48aa;
        }

        .add-doctor-form,
        .add-admin-form {
          background: #fff;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 20px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        .add-doctor-form h3,
        .add-admin-form h3 {
          color: #333;
          margin-bottom: 20px;
          text-align: center;
        }

        .form-group {
          margin-bottom: 15px;
        }

        .form-group label {
          display: block;
          font-size: 1rem;
          color: #555;
          margin-bottom: 5px;
          font-weight: 500;
        }

        .form-group input,
        .form-group select {
          width: 100%;
          padding: 8px 12px;
          border: 2px solid #ddd;
          border-radius: 8px;
          font-size: 1rem;
          color: #333;
          background: #f9f9f9;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .form-group input[readonly] {
          background: #e9ecef;
          cursor: not-allowed;
        }

        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: #6e48aa;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: #fff;
        }

        .form-group input::placeholder,
        .form-group select:invalid {
          color: #bbb;
        }

        .form-group select {
          color: #333;
        }

        .form-group select:invalid {
          color: #bbb;
        }

        .submit-button {
          width: 150px;
          padding: 10px;
          background: #6e48aa;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1.1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.3s ease;
          display: block;
          margin: 0 auto;
        }

        .submit-button:disabled {
          background: #999;
          cursor: not-allowed;
        }

        .submit-button:hover:not(:disabled) {
          background: #5a3e8b;
        }

        .error-message {
          color: #e74c3c;
          font-size: 1rem;
          margin-bottom: 20px;
          text-align: center;
        }

        .success-message {
          color: #2ecc71;
          font-size: 1rem;
          margin-bottom: 20px;
          text-align: center;
        }

        .success-container {
          text-align: center;
        }

        @media (max-width: 768px) {
          .admin-dashboard {
            padding: 20px;
          }

          h2 {
            font-size: 1.5rem;
          }

          .section {
            padding: 20px;
          }

          .menu {
            width: 200px;
            left: -200px;
          }

          .menu.open {
            left: 0;
          }
        }

        @media (max-width: 480px) {
          h2 {
            font-size: 1.2rem;
          }

          .section h3 {
            font-size: 1.2rem;
          }

          .menu {
            width: 180px;
            left: -180px;
          }

          .menu.open {
            left: 0;
          }

          .menu li {
            font-size: 1rem;
            padding: 10px;
          }
        }
      `}</style>
    </div>
  );
}

export default AdminDashboard;