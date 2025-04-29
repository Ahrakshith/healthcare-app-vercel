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
    const response = await fetch(csvPath, {
      method: 'GET',
      headers: { 'Content-Type': 'text/csv' },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch CSV: ${response.status} - ${response.statusText}`);
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
 * If verification fails, notifies the admin.
 * @param {string} disease - The disease to verify.
 * @param {string} medicine - The medicine to verify (can be a full prescription string or just the medicine name).
 * @param {string} userId - The user ID for authentication.
 * @param {string} idToken - The Firebase ID token for authentication.
 * @param {Object} profileData - Patient profile data (e.g., name, patientId).
 * @param {string} doctorId - The doctor's ID.
 * @param {string} [doctorName='Unknown Doctor'] - The doctor's name (optional, defaults to 'Unknown Doctor').
 * @returns {Promise<{ success: boolean, message: string }>} The verification result.
 */
async function verifyMedicine(disease, medicine, userId, idToken, profileData = {}, doctorId, doctorName = 'Unknown Doctor') {
  try {
    // Input validation
    if (!disease || !medicine) {
      return {
        success: false,
        message: 'Both disease and medicine must be provided.',
      };
    }

    if (!userId || !idToken) {
      return {
        success: false,
        message: 'User authentication details (userId, idToken) are required.',
      };
    }

    if (!doctorId) {
      return {
        success: false,
        message: 'Doctor ID is required for notification purposes.',
      };
    }

    const normalizedDisease = disease.trim().toLowerCase();
    // Extract just the medicine name if the input is a full prescription string (e.g., "Paracetamol, 100mg, 3.00PM, 2 days")
    const medicineName = medicine.split(',')[0].trim().toLowerCase();

    const rows = await fetchMedicineValidationCsv();

    // Iterate through each row in the CSV
    for (const row of rows) {
      if (row[0].trim().toLowerCase() === normalizedDisease) {
        // Check if medicine exists in the row (columns 1 and beyond)
        for (const item of row.slice(1)) {
          if (item && item.trim().toLowerCase() === medicineName) {
            console.log(`medicineVerify.js: Verification successful: disease=${disease}, medicine=${medicineName}`);
            return {
              success: true,
              message: 'Medication verified successfully.',
            };
          }
        }
        console.log(`medicineVerify.js: Medicine "${medicineName}" not found for disease "${disease}"`);
        const notificationMessage = `Invalid prescription: "${medicine}" for diagnosis "${disease}" (Patient: ${profileData.name || 'Unknown Patient'}, Doctor: ${doctorName})`;
        await notifyAdmin(
          profileData.name || 'Unknown Patient',
          doctorName,
          notificationMessage,
          profileData.patientId || 'Unknown',
          doctorId,
          userId,
          idToken
        );
        return {
          success: false,
          message: `Medicine "${medicineName}" not found for the specified disease "${disease}".`,
        };
      }
    }

    console.log(`medicineVerify.js: Disease "${disease}" not found in database`);
    const notificationMessage = `Disease "${disease}" not found in database for medicine "${medicine}" (Patient: ${profileData.name || 'Unknown Patient'}, Doctor: ${doctorName})`;
    await notifyAdmin(
      profileData.name || 'Unknown Patient',
      doctorName,
      notificationMessage,
      profileData.patientId || 'Unknown',
      doctorId,
      userId,
      idToken
    );
    return {
      success: false,
      message: `Disease "${disease}" not found in the database.`,
    };
  } catch (error) {
    console.error('medicineVerify.js: Error verifying medicine:', error.message);
    const notificationMessage = `Error verifying medicine: ${error.message} (Disease: ${disease}, Medicine: ${medicine}, Patient: ${profileData.name || 'Unknown Patient'}, Doctor: ${doctorName})`;
    await notifyAdmin(
      profileData.name || 'Unknown Patient',
      doctorName,
      notificationMessage,
      profileData.patientId || 'Unknown',
      doctorId,
      userId,
      idToken
    );
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
 * @param {string} message - The notification message (e.g., invalid prescription details).
 * @param {string} patientId - The patient's ID.
 * @param {string} doctorId - The doctor's ID.
 * @param {string} userId - The user ID for authentication.
 * @param {string} idToken - The Firebase ID token for authentication.
 * @returns {Promise<{ success: boolean, message: string }>} The notification result.
 */
async function notifyAdmin(patientName, doctorName, message, patientId, doctorId, userId, idToken) {
  try {
    // Input validation
    if (!patientName || !doctorName || !message || !patientId || !doctorId || !userId || !idToken) {
      console.error('medicineVerify.js: Missing required fields for notification:', {
        patientName,
        doctorName,
        message,
        patientId,
        doctorId,
        userId,
        idToken,
      });
      throw new Error('All fields (patientName, doctorName, message, patientId, doctorId, userId, idToken) are required to notify admin.');
    }

    const apiBaseUrl = 'https://healthcare-app-vercel.vercel.app/api';
    const response = await fetch(`${apiBaseUrl}/admin/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
        'x-user-uid': userId,
      },
      body: JSON.stringify({
        patientId,
        doctorId,
        message,
      }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to notify admin: ${response.status} - ${errorText || response.statusText}`);
    }

    const result = await response.json();
    console.log('medicineVerify.js: Admin notified successfully:', result);
    return {
      success: true,
      message: 'Notification sent successfully.',
    };
  } catch (error) {
    console.error('medicineVerify.js: Error notifying admin:', error.message);
    return {
      success: false,
      message: `Error notifying admin: ${error.message}`,
    };
  }
}

/**
 * Clears the cached CSV data (useful for testing or refreshing data).
 */
function clearCache() {
  cachedCsvData = null;
  console.log('medicineVerify.js: CSV cache cleared');
}

export { verifyMedicine, notifyAdmin, fetchMedicineValidationCsv, clearCache };