import Papa from 'papaparse';

// Cache for the parsed CSV data
let cachedCsvData = null;

/**
 * Fetches and parses the medicine_validation.csv file.
 * Caches the result to avoid repeated fetches.
 * @returns {Promise<Array<Array<string>>>} The parsed CSV rows.
 */
const fetchMedicineValidationCsv = async () => {
  if (cachedCsvData) {
    console.log('medicineVerify.js: Using cached CSV data');
    return cachedCsvData;
  }

  const csvPath = '/data/medicine_validation.csv';
  console.log('medicineVerify.js: Attempting to fetch medicine_validation.csv from:', csvPath);

  try {
    const response = await fetch(csvPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch CSV: ${response.statusText}`);
    }

    const csvText = await response.text();
    console.log('medicineVerify.js: Successfully fetched medicine_validation.csv, parsing content...');

    return new Promise((resolve, reject) => {
      Papa.parse(csvText, {
        header: false,
        skipEmptyLines: true,
        complete: (result) => {
          const rows = result.data;
          console.log('medicineVerify.js: Parsed CSV rows:', rows);

          if (rows.length === 0) {
            console.error('medicineVerify.js: No data found in medicine_validation.csv');
            reject(new Error('No data found in medicine_validation.csv'));
            return;
          }

          // Validate CSV structure: each row should have at least 2 columns (disease, medicine)
          const invalidRows = rows.filter((row) => row.length < 2);
          if (invalidRows.length > 0) {
            console.error('medicineVerify.js: Invalid CSV structure - some rows have fewer than 2 columns:', invalidRows);
            reject(new Error('Invalid CSV structure: Each row must have at least 2 columns (disease, medicine)'));
            return;
          }

          cachedCsvData = rows;
          resolve(rows);
        },
        error: (error) => {
          console.error('medicineVerify.js: PapaParse error while parsing CSV:', error.message);
          reject(new Error(`PapaParse error: ${error.message}`));
        },
      });
    });
  } catch (error) {
    console.error('medicineVerify.js: Error fetching CSV:', error.message);
    throw error;
  }
};

/**
 * Verifies if a medicine is valid for a given disease based on the CSV data.
 * @param {string} disease - The disease to verify.
 * @param {string} medicine - The medicine to verify.
 * @returns {Promise<{ success: boolean, message: string }>} The verification result.
 */
async function verifyMedicine(disease, medicine) {
  try {
    // Input validation
    if (!disease || !medicine) {
      return {
        success: false,
        message: 'Both disease and medicine must be provided.',
      };
    }

    const normalizedDisease = disease.trim().toLowerCase();
    const normalizedMedicine = medicine.trim().toLowerCase();

    const rows = await fetchMedicineValidationCsv();

    // Iterate through each row in the CSV
    for (const row of rows) {
      if (row[0].trim().toLowerCase() === normalizedDisease) {
        // Check if medicine exists in the row (columns 1 and beyond)
        for (const item of row.slice(1)) {
          if (item && item.trim().toLowerCase() === normalizedMedicine) {
            console.log(`medicineVerify.js: Verification successful: disease=${disease}, medicine=${medicine}`);
            return {
              success: true,
              message: 'Medication verified',
            };
          }
        }
        console.log(`medicineVerify.js: Medicine "${medicine}" not found for disease "${disease}"`);
        return {
          success: false,
          message: 'Medicine not found for the specified disease.',
        };
      }
    }

    console.log(`medicineVerify.js: Disease "${disease}" not found in database`);
    return {
      success: false,
      message: 'Disease not found in the database.',
    };
  } catch (error) {
    console.error('medicineVerify.js: Error verifying medicine:', error.message);
    return {
      success: false,
      message: `Error verifying medicine: ${error.message}`,
    };
  }
}

/**
 * Notifies the admin of an invalid prescription by sending a request to the server.
 * @param {string} patientName - The name of the patient.
 * @param {string} doctorName - The name of the doctor.
 * @param {string} disease - The disease being treated.
 * @param {string} medicine - The prescribed medicine.
 * @param {string} patientId - The patient's ID.
 * @param {string} doctorId - The doctor's ID.
 * @param {string} userId - The user's ID for authentication.
 * @param {string} idToken - The Firebase ID token for authentication.
 * @returns {Promise<{ success: boolean, message: string }>} The notification result.
 */
async function notifyAdmin(patientName, doctorName, disease, medicine, patientId, doctorId, userId, idToken) {
  try {
    // Input validation
    if (!patientName || !doctorName || !disease || !medicine || !patientId || !doctorId || !userId || !idToken) {
      throw new Error('All fields (patientName, doctorName, disease, medicine, patientId, doctorId, userId, idToken) are required to notify admin.');
    }

    const apiBaseUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
    const response = await fetch(`${apiBaseUrl}/admin?patientId=${encodeURIComponent(patientId)}&doctorId=${encodeURIComponent(doctorId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-uid': userId,
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        message: `Invalid prescription: ${medicine} for ${disease} (Patient: ${patientName}, Doctor: ${doctorName})`,
      }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to notify admin: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    console.log('medicineVerify.js: Admin notified of invalid prescription.');
    return {
      success: true,
      message: 'Admin notified of invalid prescription.',
    };
  } catch (error) {
    console.error('medicineVerify.js: Error notifying admin:', error.message);
    return {
      success: false,
      message: `Error notifying admin: ${error.message}`,
    };
  }
}

export { verifyMedicine, notifyAdmin };