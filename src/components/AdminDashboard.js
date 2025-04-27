import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminDoctors from './AdminDoctors.js';
import AdminPatients from './AdminPatients.js';
import AdminCases from './AdminCases.js';
import { SPECIALTIES } from '../constants/specialties.js';
import { doc, getDoc } from 'firebase/firestore';
import { getAuth, signOut } from 'firebase/auth';
import { db } from '../services/firebase.js';

function AdminDashboard({ user, role, handleLogout, setUser }) {
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
    qualification: '',
    address: '',
    contactNumber: '',
  });
  const [addDoctorError, setAddDoctorError] = useState('');
  const [addDoctorSuccess, setAddDoctorSuccess] = useState('');
  const [newAdmin, setNewAdmin] = useState({ email: '', password: '' });
  const [addAdminError, setAddAdminError] = useState('');
  const [addAdminSuccess, setAddAdminSuccess] = useState('');
  const [isAddingAdmin, setIsAddingAdmin] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0); // For triggering list refresh
  const navigate = useNavigate();
  const isMounted = useRef(true); // Track component mount state
  const auth = getAuth();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMounted.current = false;
      console.log('AdminDashboard: Component unmounted, cleanup complete');
    };
  }, []);

  // Authentication and role check
  useEffect(() => {
    const checkAuth = async () => {
      if (!user || role !== 'admin') {
        if (isMounted.current) {
          console.log('AdminDashboard: No user or not admin, redirecting to /login');
          navigate('/login', { replace: true });
        }
        return;
      }

      // Verify admin role from Firestore
      const adminId = localStorage.getItem('userId');
      if (adminId) {
        const userDocRef = doc(db, 'users', adminId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists() || userDoc.data().role !== 'admin') {
          if (isMounted.current) {
            setAddDoctorError('Insufficient permissions. Only admins can access this dashboard.');
            navigate('/login', { replace: true });
          }
        }
      }
    };

    checkAuth();
  }, [user, role, navigate]);

  const toggleMenu = useCallback(() => {
    if (isMounted.current) setMenuOpen((prev) => !prev);
  }, []);

  const handleViewChange = useCallback((view) => {
    if (isMounted.current) {
      setCurrentView(view);
      setMenuOpen(false);
      if (view === 'add-doctor') {
        setShowAddForm(true);
        setAddDoctorSuccess('');
        setAddDoctorError('');
        setNewDoctor({
          name: '',
          age: '',
          sex: '',
          experience: '',
          specialty: SPECIALTIES[0],
          email: '',
          password: '',
          qualification: '',
          address: '',
          contactNumber: '',
        });
      }
    }
  }, []);

  const handleDoctorInputChange = useCallback((e) => {
    const { name, value } = e.target;
    if (isMounted.current) setNewDoctor((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleAddDoctor = useCallback(async (e) => {
    e.preventDefault();
    if (!isMounted.current) return;

    setAddDoctorError('');
    setAddDoctorSuccess('');

    const adminId = localStorage.getItem('userId');
    console.log('AdminDashboard: Admin UID from localStorage:', adminId);
    if (!adminId) {
      setAddDoctorError('Admin ID not found. Please log in again.');
      navigate('/login', { replace: true });
      return;
    }

    const userDocRef = doc(db, 'users', adminId);
    const userDoc = await getDoc(userDocRef);
    if (!userDoc.exists() || userDoc.data().role !== 'admin') {
      setAddDoctorError('Insufficient permissions. Only admins can add doctors.');
      return;
    }

    const requiredFields = [
      'name',
      'age',
      'sex',
      'experience',
      'specialty',
      'email',
      'password',
      'qualification',
      'address',
      'contactNumber',
    ];
    const missingFields = requiredFields.filter((field) => !newDoctor[field]);
    if (missingFields.length > 0) {
      setAddDoctorError(`Please fill in all fields: ${missingFields.join(', ')}.`);
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
      const idToken = await auth.currentUser?.getIdToken(true);
      if (!idToken) throw new Error('Authentication token not available.');

      const doctorData = {
        role: 'doctor',
        email: newDoctor.email,
        password: newDoctor.password,
        name: newDoctor.name,
        age: parseInt(newDoctor.age),
        sex: newDoctor.sex,
        experience: parseInt(newDoctor.experience),
        specialty: newDoctor.specialty,
        qualification: newDoctor.qualification,
        address: newDoctor.address,
        contactNumber: newDoctor.contactNumber,
      };

      console.log('AdminDashboard: Sending request to /api/users with payload:', doctorData);
      const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
      const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
      const createResponse = await fetch(`${apiUrl}/api/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': adminId,
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify(doctorData),
        credentials: 'include',
      });

      const responseText = await createResponse.text();
      console.log('AdminDashboard: Raw response status:', createResponse.status, 'body:', responseText);

      let createData;
      try {
        createData = responseText ? JSON.parse(responseText) : {};
      } catch (jsonError) {
        throw new Error(`Failed to parse response as JSON: ${jsonError.message}. Raw response: ${responseText}`);
      }

      if (!createResponse.ok) throw new Error(createData.error?.message || `Failed to create doctor: ${createResponse.statusText}`);

      const { doctorId, uid } = createData;
      console.log('AdminDashboard: Doctor added with doctorId:', doctorId, 'and UID:', uid);

      if (isMounted.current) {
        setAddDoctorSuccess('Doctor added successfully!');
        setNewDoctor({
          name: '',
          age: '',
          sex: '',
          experience: '',
          specialty: SPECIALTIES[0],
          email: '',
          password: '',
          qualification: '',
          address: '',
          contactNumber: '',
        });
        setShowAddForm(false);
        setRefreshTrigger((prev) => prev + 1); // Trigger refresh of doctors list
      }
    } catch (err) {
      console.error('AdminDashboard: Error adding doctor - Details:', err);
      if (isMounted.current) {
        let errorMessage = err.message;
        if (err.message.includes('email-already-in-use') || err.message.includes('This email is already registered')) {
          errorMessage = 'This email is already registered.';
        } else if (err.message.includes('invalid-email')) {
          errorMessage = 'Please enter a valid Gmail address (e.g., example@gmail.com).';
        } else if (err.message.includes('weak-password')) {
          errorMessage = 'Password should be at least 6 characters long.';
        } else if (err.message.includes('Forbidden')) {
          errorMessage = 'Insufficient permissions to add doctor.';
        } else if (err.message.includes('A server error has occurred') || err.message.includes('FUNCTION_INVOCATION_FAILED')) {
          errorMessage = 'A server error occurred. Please try again later.';
        } else if (err.message.includes('Failed to parse response as JSON')) {
          errorMessage = 'A server error occurred. Please try again later.';
        } else {
          errorMessage = 'An unexpected error occurred. Please try again.';
        }
        setAddDoctorError(`Error adding doctor: ${errorMessage}`);
      }
    }
  }, [newDoctor, navigate]);

  const handleAdminInputChange = useCallback((e) => {
    const { name, value } = e.target;
    if (isMounted.current) setNewAdmin((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleAddAdmin = useCallback(async (e) => {
    e.preventDefault();
    if (!isMounted.current) return;

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
      const idToken = await auth.currentUser?.getIdToken(true);
      if (!idToken) throw new Error('Authentication token not available.');

      const adminData = {
        role: 'admin',
        email: newAdmin.email,
        password: newAdmin.password,
      };

      const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
      const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
      const response = await fetch(`${apiUrl}/api/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': localStorage.getItem('userId'),
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify(adminData),
        credentials: 'include',
      });

      const responseText = await response.text();
      let responseData;
      try {
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch (jsonError) {
        throw new Error(`Failed to parse response as JSON: ${jsonError.message}. Raw response: ${responseText}`);
      }

      if (!response.ok) throw new Error(responseData.error?.message || `Failed to create admin: ${response.statusText}`);

      const adminUid = responseData.uid;
      console.log('AdminDashboard: New admin created with UID:', adminUid);

      if (isMounted.current) {
        setAddAdminSuccess('Admin added successfully!');
        setNewAdmin({ email: '', password: '' });
      }
    } catch (error) {
      console.error('AdminDashboard: Add admin error - Details:', error);
      if (isMounted.current) {
        let errorMessage = error.message;
        if (error.message.includes('email-already-in-use') || error.message.includes('This email is already registered')) {
          errorMessage = 'This email is already registered.';
        } else if (error.message.includes('invalid-email')) {
          errorMessage = 'Please enter a valid Gmail address (e.g., example@gmail.com).';
        } else if (error.message.includes('weak-password')) {
          errorMessage = 'Password should be at least 6 characters long.';
        } else if (error.message.includes('Forbidden')) {
          errorMessage = 'Insufficient permissions to add admin.';
        } else if (error.message.includes('A server error has occurred') || error.message.includes('FUNCTION_INVOCATION_FAILED')) {
          errorMessage = 'A server error occurred. Please try again later.';
        } else if (error.message.includes('Failed to parse response as JSON')) {
          errorMessage = 'A server error occurred. Please try again later.';
        } else {
          errorMessage = 'An unexpected error occurred. Please try again.';
        }
        setAddAdminError(`Failed to add admin: ${errorMessage}`);
      }
    } finally {
      if (isMounted.current) setIsAddingAdmin(false);
    }
  }, [newAdmin]);

  const handleLogoutClick = useCallback(async () => {
    if (!isMounted.current) return;

    console.log('AdminDashboard: Initiating logout');
    try {
      await signOut(auth);
      const baseApiUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app';
      const apiUrl = baseApiUrl.endsWith('/api') ? baseApiUrl.replace(/\/api$/, '') : baseApiUrl;
      await fetch(`${apiUrl}/api/misc/logout`, {
        method: 'POST',
        headers: {
          'x-user-uid': localStorage.getItem('userId'),
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      if (handleLogout) await handleLogout();
      if (isMounted.current) {
        navigate('/login', { replace: true });
        console.log('AdminDashboard: Logged out successfully');
      }
    } catch (err) {
      console.error('AdminDashboard: Logout error:', err.message);
      if (isMounted.current) setAddDoctorError('Failed to log out. Please try again.');
    }
  }, [navigate, handleLogout]);

  // Callback to trigger list refresh after deletion
  const refreshList = useCallback(() => {
    if (isMounted.current) {
      setRefreshTrigger((prev) => prev + 1);
    }
  }, []);

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
          <li onClick={handleLogoutClick}>Logout</li>
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
                      if (isMounted.current) {
                        setShowAddForm(true);
                        setAddDoctorSuccess('');
                        setNewDoctor({
                          name: '',
                          age: '',
                          sex: '',
                          experience: '',
                          specialty: SPECIALTIES[0],
                          email: '',
                          password: '',
                          qualification: '',
                          address: '',
                          contactNumber: '',
                        });
                      }
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
            <AdminDoctors refreshTrigger={refreshTrigger} refreshList={refreshList} />
          </div>
        )}

        {currentView === 'patients' && (
          <div className="section">
            <h3>Patients List</h3>
            <AdminPatients refreshTrigger={refreshTrigger} refreshList={refreshList} />
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

export default React.memo(AdminDashboard, (prevProps, nextProps) => {
  return prevProps.user === nextProps.user && prevProps.role === nextProps.role;
});