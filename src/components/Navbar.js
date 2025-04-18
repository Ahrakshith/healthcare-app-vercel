// src/components/Navbar.js
import React from 'react';
import { Link } from 'react-router-dom';

function Navbar() {
  return (
    <nav className="navbar">
      <Link to="/admin/patients">Patients</Link>
      <Link to="/admin/doctors">Doctors</Link>
      <Link to="/admin/cases">Cases</Link>
    </nav>
  );
}

export default Navbar;