const bcrypt = require('bcrypt');

const password ="admin@123"
const hashedPass=bcrypt.hashSync(password,10);
console.log(hashedPass);


// INSERT INTO users (email, password_hash, name, employee_id, role) 
//        VALUES ('admin@gmail.com', '$2b$10$Ajh7tC9qZdSajmlFuTH60uijSuTNGRiFJQyC7CfPOUx5j8lvGzIZS', 'Admin User', 'ADM001', 'admin') 
