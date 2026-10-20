const fs = require('node:fs');
const path = require('node:path');

const firstNames = [
  'Aarav', 'Aarohi', 'Aarush', 'Aadhya', 'Aahana', 'Aanya', 'Aayush', 'Abhay', 'Abhinav', 'Aditya',
  'Advait', 'Aishwarya', 'Akash', 'Akhil', 'Akshara', 'Amara', 'Amaya', 'Amit', 'Amrita', 'Ananya',
  'Anika', 'Anirudh', 'Anjali', 'Anoushka', 'Arjun', 'Arnav', 'Arya', 'Ashwin', 'Avani', 'Avika',
  'Ayush', 'Bhavya', 'Chaitanya', 'Charvi', 'Dev', 'Dhruv', 'Diya', 'Esha', 'Gauri', 'Harini',
  'Ishan', 'Ishita', 'Jaya', 'Kabir', 'Karthik', 'Kavya', 'Kiara', 'Kiran', 'Krish', 'Lakshmi',
  'Lavanya', 'Madhav', 'Meera', 'Mihir', 'Mira', 'Naina', 'Nakul', 'Nandini', 'Neel', 'Neha',
  'Nikhil', 'Nisha', 'Noor', 'Om', 'Parth', 'Pooja', 'Pranav', 'Prisha', 'Qasim', 'Radhika',
  'Raghav', 'Rahul', 'Rhea', 'Rishi', 'Rohan', 'Ruhi', 'Saanvi', 'Sakshi', 'Samira', 'Sara',
  'Sarthak', 'Shanaya', 'Shreya', 'Siddharth', 'Simran', 'Siya', 'Sneha', 'Tanvi', 'Tara', 'Uday',
  'Uma', 'Ved', 'Veda', 'Veer', 'Vihaan', 'Vikram', 'Yash', 'Zain', 'Zoya', 'Ayesha'
];

const lastNames = [
  'Acharya', 'Agarwal', 'Ahuja', 'Anand', 'Apte', 'Arora', 'Bansal', 'Banerjee', 'Batra', 'Bedi',
  'Bhatt', 'Bhat', 'Bhatia', 'Biswas', 'Bose', 'Chandra', 'Chatterjee', 'Chawla', 'Chopra', 'Das',
  'Desai', 'Deshmukh', 'Deshpande', 'Dewan', 'Dhawan', 'Dutta', 'Fernandes', 'Ganguly', 'Ghosh', 'Gill',
  'Gokhale', 'Goel', 'Goswami', 'Gupta', 'Hegde', 'Iyer', 'Jadhav', 'Jain', 'Jha', 'Joshi',
  'Kapoor', 'Kaur', 'Khandelwal', 'Khanna', 'Khurana', 'Kulkarni', 'Kumar', 'Lal', 'Lamba', 'Malhotra',
  'Menon', 'Mishra', 'Modi', 'Mukherjee', 'Murthy', 'Nair', 'Naidu', 'Narayan', 'Oberoi', 'Pal',
  'Pandey', 'Patel', 'Patil', 'Pillai', 'Prasad', 'Qureshi', 'Rao', 'Reddy', 'Roy', 'Saha',
  'Saini', 'Sanyal', 'Sarkar', 'Shah', 'Sharma', 'Shastri', 'Shetty', 'Shinde', 'Singh', 'Sinha',
  'Sood', 'Srinivasan', 'Subramanian', 'Sur', 'Talwar', 'Thakur', 'Thapar', 'Tripathi', 'Trivedi', 'Tyagi',
  'Upadhyay', 'Varma', 'Verma', 'Wadhwa', 'Yadav', 'Yellapragada', 'Zacharia', "D'Souza", 'Borkar', 'Choudhary'
];

const names = firstNames.flatMap(first => lastNames.map(last => `${first} ${last}`));
const destination = path.join(__dirname, 'player-names.json');
fs.writeFileSync(destination, `${JSON.stringify(names)}\n`);
console.log(`Wrote ${names.length} unique player names to ${destination}`);