import csv


def verify_values(csv_file_path, value1, value2):
    try:
        with open(csv_file_path, 'r', newline='') as file:
            csv_reader = csv.reader(file)

            # Iterate through each row in the CSV
            for row in csv_reader:
                # Check if row is not empty and first column matches value1 exactly
                if row and row[0].strip().lower() == value1.strip().lower():
                    # Check if value2 exists as a complete value in the row
                    for item in row[1:]:  # Skip first column
                        if item.strip().lower() == value2.strip().lower():
                            return "Medication verified"
                    return "Error Wrong Medication"
            return "No disease doesn't exist in the DB"

    except FileNotFoundError:
        return "Error: CSV file not found"
    except Exception as e:
        return f"Error: {str(e)}"


def main():
    # Assuming your CSV file is named 'data.csv'
    csv_file_path = r'/Users/ah1/PycharmProjects/healthcare-app/healthcare-app/medicibe_validation.csv'

    while True:
        # Get input from user
        input_values = input("Enter two values separated by comma (e.g., acne,ziana) or 'exit' to quit: ")

        # Check for exit condition
        if input_values.strip().lower() == 'exit':
            print("Exiting program...")
            break

        # Process the input
        try:
            value1, value2 = [x.strip() for x in input_values.split(',', 1)]

            # Verify the values
            result = verify_values(csv_file_path, value1, value2)
            print(result)

        except ValueError:
            print("Error: Please enter two values separated by a comma or 'exit'")


if __name__ == "__main__":
    main()