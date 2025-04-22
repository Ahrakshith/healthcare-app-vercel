export default async function handler(req, res) {
  console.log('Test function running at', new Date().toISOString());
  res.status(200).json({ message: 'Test successful' });
}