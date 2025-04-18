// src/services/medicineVerify.js
import { db } from './firebase.js';
import { collection, addDoc } from 'firebase/firestore';
import Papa from 'papaparse';

let medicineData = null;

async function loadMedicineData() {
  if (medicineData) {
    return medicineData;
  }

  try {
    const response = await fetch('/Users/ah1/PycharmProjects/healthcare-app/healthcare-app/medicibe_validation.csv'); // Ensure correct path
    if (!response.ok) {
      throw new Error(`Failed to fetch medicine.csv: ${response.statusText}`);
    }
    const csvText = await response.text();

    return new Promise((resolve, reject) => {
      Papa.parse(csvText, {
        header: false,
        skipEmptyLines: true,
        complete: (result) => {
          const data = {};
          const rows = result.data;

          if (rows.length === 0) {
            reject(new Error('No data found in medicine.csv'));
            return;
          }

          for (const row of rows) {
            const cleanedRow = row.map((col) => col && col.trim().toLowerCase()).filter(Boolean);
            if (cleanedRow.length > 1) {
              const disease = cleanedRow[0];
              data[disease] = new Set(cleanedRow.slice(1));
            }
          }

          if (Object.keys(data).length === 0) {
            reject(new Error('No valid data found in medicine.csv'));
          }

          medicineData = data;
          resolve(data);
        },
        error: (error) => reject(error),
      });
    });
  } catch (error) {
    console.error('Error loading medicine data:', error);
    throw error;
  }
}

async function verifyMedicine(disease, medicine) {
  try {
    if (!disease || !medicine) {
      return "Error: Both disease and medicine must be provided.";
    }

    const data = await loadMedicineData();
    const diseaseKey = disease.trim().toLowerCase();
    const medicineKey = medicine.trim().toLowerCase();

    if (!(diseaseKey in data)) {
      return "No disease doesn't exist in the DB";
    }

    return data[diseaseKey].has(medicineKey) ? "Medication verified" : "Error Wrong Medication";
  } catch (error) {
    console.error('Error verifying medicine:', error);
    return `Error: ${error.message}`;
  }
}

async function notifyAdmin(patientName, doctorName, disease, medicine) {
  try {
    if (!patientName || !doctorName || !disease || !medicine) {
      throw new Error('All fields are required to notify admin.');
    }

    await addDoc(collection(db, 'admin_notifications'), {
      patientName,
      doctorName,
      disease,
      medicine,
      status: 'invalid',
      timestamp: new Date().toISOString(),
    });

    console.log('Admin notified of invalid prescription.');
  } catch (error) {
    console.error('Error notifying admin:', error);
    throw error;
  }
}

export { verifyMedicine, notifyAdmin };
